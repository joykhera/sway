import type { MusicIntent } from '../shared/intent.ts';
import type { FeatureBlend, LearnerState, ListeningPurpose, Target, Vote } from '../shared/protocol';

export type SavedProfile = {
  purpose: ListeningPurpose;
  state: LearnerState;
  updatedAt: number;
  intent?: MusicIntent;
  intentText?: string;
};

export type FeedbackRecord = {
  id: string;
  at: number;
  sessionId: string;
  purpose: ListeningPurpose;
  vote: Vote;
  audible: FeatureBlend;
  previous?: FeatureBlend;
  evidenceWeight: number;
  targetBefore: Target;
  targetAfter: Target;
  intent?: MusicIntent;
  intentText?: string;
  // False while older audio is still playing after a text request; evidence is zero.
  intentAppliedToAudible?: boolean;
};

export type SavedPreferences = {
  purpose?: ListeningPurpose;
  profiles: Partial<Record<ListeningPurpose, SavedProfile>>;
};

export interface PreferencesStore {
  load(): Promise<SavedPreferences>;
  save(profile: SavedProfile, event?: FeedbackRecord): Promise<void>;
  selectPurpose(purpose: ListeningPurpose): Promise<void>;
  export(): Promise<string>;
  clear(): Promise<void>;
}

export type BrowserPreferencesOptions = {
  /** Omit to use this browser's IndexedDB; null explicitly disables storage. */
  indexedDB?: IDBFactory | null;
  databaseName?: string;
  /** Global retained feedback limit, at most 10,000. Profiles are not pruned. */
  maxEvents?: number;
  /** Bounds opening and each transaction, including blocked opens. Default: 3 seconds. */
  timeoutMs?: number;
};
