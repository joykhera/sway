import { createBrowserPreferencesStore } from '../../src/preferences';
import type { FeedbackRecord, SavedPreferences, SavedProfile } from '../../src/preferences';
import type { ListeningPurpose } from '../../src/shared/protocol';

const status = document.querySelector<HTMLElement>('#status')!;
const results = document.querySelector<HTMLOListElement>('#results')!;
const databaseName = `sway-preferences-proof-${Date.now()}-${Math.random().toString(36).slice(2)}`;
document.querySelector<HTMLElement>('#database')!.textContent = `Scratch database: ${databaseName}`;
let passed = 0;

function check(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(description);
  passed++;
  const row = document.createElement('li');
  row.textContent = `PASS — ${description}`;
  results.append(row);
}

// Storage fixtures deliberately test opaque extra fields; they are not trained preference models.
function profile(purpose: ListeningPurpose, votes: number): SavedProfile {
  return {
    purpose,
    updatedAt: 1000 + votes,
    state: { scores: { piano: 0.2 }, votes, seed: 123, purpose,
      A: [[0.35, 0], [0, 0.35]], b: [0.1, -0.1], pairwiseEvidence: 0.5 } as SavedProfile['state'],
  };
}

function feedback(id: string, purpose: ListeningPurpose, at: number, evidenceWeight = 1): FeedbackRecord {
  const target = { features: { piano: 0.6 }, prompts: [{ text: 'Soft piano', weight: 0.6 }] };
  return {
    id, purpose, at, sessionId: 'browser-proof', vote: evidenceWeight === 0 ? 'down' : 'up',
    audible: { piano: 0.6 }, evidenceWeight,
    ...(evidenceWeight > 0 ? { previous: { piano: 0.4 } } : {}),
    targetBefore: target, targetAfter: target,
  };
}

type Exported = SavedPreferences & { schemaVersion: number; feedback: FeedbackRecord[]; retention: { maxFeedbackRecords: number } };
const exported = async (store: ReturnType<typeof createBrowserPreferencesStore>): Promise<Exported> => JSON.parse(await store.export()) as Exported;

function deleteScratchDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    const timer = setTimeout(() => reject(new Error('Scratch database cleanup timed out')), 3000);
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error('Scratch database cleanup failed')); };
    // Store connections receive versionchange and close themselves; wait within the bounded timer.
  });
}

async function run(): Promise<void> {
  const store = createBrowserPreferencesStore({ databaseName, maxEvents: 3 });
  let failure: unknown;
  try {
    const empty = await store.load();
    check(empty.purpose === undefined && Object.keys(empty.profiles).length === 0, 'A new database has no profiles or selection');
    await store.selectPurpose('crazy');
    await store.save(profile('focus', 1), feedback('e1', 'focus', 4000));
    await store.save(profile('crazy', 1), feedback('e2', 'crazy', 3000, 0));
    await store.save(profile('relax', 1), feedback('e3', 'relax', 2000));
    await store.save(profile('crazy', 2), feedback('e4', 'crazy', 1000));

    const reloadedStore = createBrowserPreferencesStore({ databaseName, maxEvents: 3 });
    const reloaded = await reloadedStore.load();
    check(reloaded.purpose === 'crazy', 'Selection survives new store instances and saves to other purposes');
    check(reloaded.profiles.crazy?.state.votes === 2 && reloaded.profiles.focus?.state.votes === 1
      && reloaded.profiles.relax?.state.votes === 1, 'Crazy and other purpose profiles reload independently');
    check(JSON.stringify(reloaded.profiles.crazy) === JSON.stringify(profile('crazy', 2)),
      'The stored model preserves opaque matrices and directional evidence');

    const beforeDuplicate = await exported(reloadedStore);
    check(beforeDuplicate.schemaVersion === 1 && beforeDuplicate.retention.maxFeedbackRecords === 3,
      'Export declares schema and retention limits');
    check(beforeDuplicate.feedback.map(event => event.id).join(',') === 'e2,e3,e4',
      'Retention prunes the oldest inserted event despite backwards timestamps');
    check(beforeDuplicate.feedback[0]?.evidenceWeight === 0 && beforeDuplicate.feedback[0]?.vote === 'down'
      && beforeDuplicate.feedback[0]?.previous === undefined && beforeDuplicate.feedback[1]?.previous?.piano === 0.4,
    'Export retains raw zero-evidence clicks and actual optional comparison data');

    let duplicateRejected = false;
    try { await reloadedStore.save(profile('crazy', 99), feedback('e4', 'crazy', 5000)); }
    catch (error) { duplicateRejected = error instanceof DOMException && error.name === 'ConstraintError'; }
    check(duplicateRejected, 'A duplicate event ID rejects the write');
    const afterDuplicate = await exported(reloadedStore);
    check(JSON.stringify(afterDuplicate.profiles) === JSON.stringify(beforeDuplicate.profiles)
      && JSON.stringify(afterDuplicate.feedback) === JSON.stringify(beforeDuplicate.feedback),
    'The failed duplicate write rolls back both profile and event changes atomically');

    await reloadedStore.clear();
    const cleared = await exported(store);
    check(cleared.purpose === undefined && Object.keys(cleared.profiles).length === 0 && cleared.feedback.length === 0,
      'Clear removes selection, every purpose profile, and raw feedback across open instances');
    await store.save(profile('energy', 1), feedback('after-clear', 'energy', 6000));
    check((await reloadedStore.load()).profiles.energy?.state.votes === 1, 'The store can save again after clearing');
  } catch (error) { failure = error; }
  finally {
    try {
      await deleteScratchDatabase();
      check(true, 'Scratch database deleted; versionchange closed all store connections');
    } catch (error) { failure ??= error; }
  }
  if (failure) {
    status.dataset.status = 'fail';
    status.textContent = `FAIL after ${passed} checks`;
    const row = document.createElement('li');
    row.textContent = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
    results.append(row);
  } else {
    status.dataset.status = 'pass';
    status.textContent = `PASS — ${passed} real IndexedDB checks`;
  }
}

void run();
