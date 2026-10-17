import type { ListeningPurpose } from '../shared/protocol';
import type { BrowserPreferencesOptions, FeedbackRecord, PreferencesStore, SavedPreferences, SavedProfile } from './types';
import { isPurpose, PURPOSES, readFeedback, readProfile, readPurpose, SCHEMA_VERSION, snapshotFeedback, snapshotProfile } from './validation';

export type { BrowserPreferencesOptions, FeedbackRecord, PreferencesStore, SavedPreferences, SavedProfile } from './types';
export const PREFERENCES_DATABASE = 'sway-preferences';
export const MAX_FEEDBACK_RECORDS = 10_000;

const STORES = ['profiles', 'feedback', 'metadata'];
const failure = (message: string) => new Error(`Preference storage: ${message}`);

/** This store rejects failures. The controller decides how to continue without persistence. */
export function createBrowserPreferencesStore(options: BrowserPreferencesOptions = {}): PreferencesStore {
  const databaseName = options.databaseName ?? PREFERENCES_DATABASE;
  const maxEvents = options.maxEvents ?? MAX_FEEDBACK_RECORDS;
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!databaseName || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_FEEDBACK_RECORDS
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new TypeError('Invalid preference storage options');
  }
  let database: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let done = false;
      const rejectOpen = (error: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => rejectOpen(failure('opening timed out')), timeoutMs);
      try {
        const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
        if (!factory) throw failure('IndexedDB is unavailable');
        const request = factory.open(databaseName, SCHEMA_VERSION);
        request.onblocked = () => rejectOpen(failure('database upgrade is blocked by another tab'));
        request.onerror = () => rejectOpen(request.error ?? failure('opening failed'));
        request.onupgradeneeded = () => {
          if (done) { request.transaction?.abort(); return; }
          try {
            const db = request.result;
            db.createObjectStore('profiles', { keyPath: 'purpose' });
            const feedback = db.createObjectStore('feedback', { autoIncrement: true });
            feedback.createIndex('id', 'id', { unique: true });
            db.createObjectStore('metadata', { keyPath: 'key' });
          } catch (error) {
            request.transaction?.abort();
            rejectOpen(error);
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (done) { db.close(); return; }
          done = true;
          clearTimeout(timer);
          database = db;
          db.onversionchange = () => {
            db.close();
            if (database === db) database = undefined;
          };
          db.onclose = () => { if (database === db) database = undefined; };
          resolve(db);
        };
      } catch (error) { rejectOpen(error); }
    });
    opening = pending;
    // Both success and failure release the shared opening promise so failures are retryable.
    void pending.then(() => { if (opening === pending) opening = undefined; },
      () => { if (opening === pending) opening = undefined; });
    return pending;
  }

  async function transaction<T>(stores: string[], mode: IDBTransactionMode,
    enqueue: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(stores, mode); }
      catch (error) { reject(error); return; }
      let value: T;
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(() => {
        finish(failure('transaction timed out'));
        try { tx.abort(); } catch { /* The transaction may have completed concurrently. */ }
      }, timeoutMs);
      tx.oncomplete = () => finish();
      tx.onabort = () => finish(tx.error ?? failure('transaction aborted'));
      // Request errors retain their default behavior: abort the entire transaction.
      try { enqueue(tx, result => { value = result; }); }
      catch (error) {
        finish(error);
        try { tx.abort(); } catch { /* Already inactive. */ }
      }
    });
  }

  function readPreferences(tx: IDBTransaction): SavedPreferences {
    const result: SavedPreferences = { profiles: {} };
    for (const purpose of PURPOSES) {
      const request = tx.objectStore('profiles').get(purpose);
      request.onsuccess = () => {
        const profile = readProfile(request.result);
        if (profile?.purpose === purpose) result.profiles[purpose] = profile;
      };
    }
    const purpose = tx.objectStore('metadata').get('purpose');
    purpose.onsuccess = () => {
      const selected = readPurpose(purpose.result);
      if (selected) result.purpose = selected;
    };
    return result;
  }

  return {
    load: () => transaction(['profiles', 'metadata'], 'readonly', (tx, result) => result(readPreferences(tx))),

    async save(profile: SavedProfile, event?: FeedbackRecord): Promise<void> {
      // Snapshot before the first await: subsequent caller mutations cannot change this write.
      const saved = snapshotProfile(profile);
      const feedback = event === undefined ? undefined : snapshotFeedback(event);
      if (feedback && feedback.purpose !== saved.purpose) throw new TypeError('Feedback and profile purposes differ');
      return transaction(['profiles', 'feedback'], 'readwrite', (tx, result) => {
        tx.objectStore('profiles').put({ ...saved, schemaVersion: SCHEMA_VERSION });
        if (feedback) {
          const events = tx.objectStore('feedback');
          events.add({ ...feedback, schemaVersion: SCHEMA_VERSION });
          const count = events.count();
          count.onsuccess = () => {
            let excess = count.result - maxEvents;
            if (excess <= 0) return;
            const oldest = events.openCursor();
            oldest.onsuccess = () => {
              const cursor = oldest.result;
              if (!cursor || excess <= 0) return;
              cursor.delete();
              if (--excess > 0) cursor.continue();
            };
          };
        }
        result(undefined);
      });
    },

    async selectPurpose(purpose: ListeningPurpose): Promise<void> {
      if (!isPurpose(purpose)) throw new TypeError('Invalid listening purpose');
      return transaction(['metadata'], 'readwrite', (tx, result) => {
        tx.objectStore('metadata').put({ key: 'purpose', purpose, schemaVersion: SCHEMA_VERSION });
        result(undefined);
      });
    },

    async export(): Promise<string> {
      const snapshot = await transaction<{ preferences: SavedPreferences; feedback: FeedbackRecord[] }>(STORES, 'readonly', (tx, result) => {
        const preferences = readPreferences(tx);
        const feedback: FeedbackRecord[] = [];
        // Bounded even if another version or a manually edited DB exceeds the retention limit.
        let visited = 0;
        const request = tx.objectStore('feedback').openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const event = readFeedback(cursor.value);
          if (event) feedback.push(event);
          if (++visited < maxEvents) cursor.continue();
        };
        result({ preferences, feedback });
      });
      return JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        exportedAt: Date.now(),
        ...snapshot.preferences,
        feedback: snapshot.feedback.reverse(),
        retention: { maxFeedbackRecords: maxEvents, order: 'insertion', scope: 'all purposes' },
      }, null, 2);
    },

    clear: () => transaction(STORES, 'readwrite', (tx, result) => {
      for (const name of STORES) tx.objectStore(name).clear();
      result(undefined);
    }),
  };
}
