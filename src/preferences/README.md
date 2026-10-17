# Browser preference storage

`createBrowserPreferencesStore()` implements `PreferencesStore` with IndexedDB, using the browser's current origin and the `sway-preferences` database. It has no server or filesystem storage and does not store credentials or audio. Different schemes, hostnames, ports, browser profiles, and private sessions have separate storage. Browser clearing, eviction, private browsing, or a storage denial can remove or prevent persistence; this is not a backup or synchronization service.

The public types are exported from `index.ts`. Tests and browser diagnostics can inject `{ indexedDB, databaseName, maxEvents, timeoutMs }`. `indexedDB: null` explicitly models unavailable storage; omitting it uses `globalThis.indexedDB`.

## Transactions and failures

- `save(profile, event?)` atomically writes one purpose's model and optional raw feedback event. Every feedback click, including zero-evidence clicks, may be recorded. A duplicate event ID rejects the whole transaction rather than silently replacing a historical event. Caller data is copied before the first asynchronous wait.
- `selectPurpose(purpose)` alone writes the selected-purpose metadata. Delayed model saves cannot change that selection.
- `load()` reads selected purpose and the five purpose profiles (including Crazy) in one transaction. The controller validates the adaptive model before using it and creates an audio target from the restored model. A current playback target is not saved as a profile.
- `export()` returns a JSON snapshot containing `schemaVersion`, `exportedAt`, selected `purpose` when present, `profiles`, `feedback`, and `retention`. Feedback contains the actual audible blend, before/after targets, effective evidence weight, and optional comparison blend supplied by the controller.
- `clear()` atomically clears profiles, selection, and feedback. The store remains usable afterward. The controller must serialize its queued writes and clearing/profile-switch operations so an older queued save cannot repopulate cleared state.

All operation failures reject. The caller should report unavailable memory and continue playback; no fallback claims to save data. A blocked open rejects immediately, and opens and individual transactions each time out after three seconds by default. A late opened connection is closed. Failed opens can be retried; existing connections close on a database version change. IndexedDB transaction success confirms the browser accepted the write, not that data can survive every browser/OS crash or future eviction.

## Schema and retention

Database version 1 uses `profiles` (purpose key), `metadata` (key), and `feedback` (auto-increment insertion-order key, unique event-ID index). Stored profile and feedback envelopes carry `schemaVersion: 1`. New versions need an explicit migration; unknown or malformed record envelopes are omitted on load/export rather than interpreted. Such records are not silently deleted by a read.

The feedback log retains the most recent **10,000 records across all purposes**, pruning the oldest inserted records in the same transaction as each new event. Clock changes do not reorder or replace events. `maxEvents` can lower this limit for browser checks. Pruning does not remove profiles or reduce their cumulative vote counts; saved model clicks can therefore exceed the number of retained export records. An export scans at most the configured number of newest raw records and omits malformed ones.

Model fields are opaque JSON extensions of the shared learner state. Envelope validation checks purpose consistency, basic shared fields, finite JSON values, bounded depth/collections, and conservative size limits (at most 256 KiB for a profile and 32 KiB for a feedback record). It preserves adaptive matrices, directional evidence, and target diagnostics. It deliberately does not claim to validate covariance matrices or other model invariants: the learner adapter owns that check.

## Verification

Unit tests cover preservation/detachment of model fields, raw zero-evidence events, corrupt/oversized inputs, and unavailable, blocked, failed, and timed-out opens. Opening-request stubs only exercise failure handling; they do not simulate an IndexedDB database.

Real-browser checks should use a disposable injected database name and a small retention limit: save/load across store instances; verify separate purpose profiles and selection; append enough events to prune insertion order; confirm duplicate IDs roll back both model and event; export; clear; then reload. No provider or audio-generation calls are needed for these checks.
