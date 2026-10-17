# Part B — Browser PCM player + responsive UI + App wiring: plan

Owner: B (`src/ui/**`, `src/audio/**`, `src/App.tsx`). Branch: `peytonli`.
Status: complete — 112/112 tests green, typecheck + build clean, live dev-server smoke passed (start → playing → votes → stop). 2026-10-17.

## Decisions (and how they differ from the handoff)

| Topic | Decision | Differs from handoff? |
|---|---|---|
| Contract location | **`MusicSessionController`/`SessionUiState` live in `src/ui/contracts.ts`; `PCMPlayer`/`PCMPlayerStats` live in `src/audio/types.ts`** — not `src/shared/protocol.ts`. D's contract stubs weren't scaffolded when B started, so B declared what the UI consumes and what the player exposes. Structural typing keeps D free to import these types or mirror them; the wire types in protocol.ts stay D-owned. | Yes — the handoff puts both abstractions in the shared protocol file |
| Mobile | **Still built responsive** (layout + thumb hit targets) but **device verification deferred** per A's localhost-only decision — no tunnel, so no phone checks for MVP. | Clarifies: code stays responsive, manual test 6 stays deferred |
| Dev server | `pnpm dev` runs `vite` **and** `tsx watch server/index.ts` via concurrently, and `server/` is still A's stub. **B's standalone path is `pnpm exec vite`** — the page loads, the `/api/music` proxy just has nothing behind it until A ships. Mock mode needs no server. | Clarifies |
| Component tests | **jsdom + @testing-library/react added as devDeps.** Vitest env stays `node` globally; DOM tests opt in with `// @vitest-environment jsdom` on line 1. `vitest.config.ts` include widened to `src/**/*.test.{ts,tsx}`. | New — the handoff only mandated Vitest |

## Audio architecture

Pipeline: `enqueuePcm(bytes)` → byte assembler (chunks may split mid-frame; leftovers are carried until the remaining bytes of the 4-byte s16le stereo frame arrive) → s16le→float32 decode (scaled by 1/32768) → streaming linear resample from the configured source rate to the `AudioContext` rate (the last input frame is kept as the next call's interpolation anchor, so arbitrary chunking is bit-identical) → fixed-capacity ring buffer inside an `AudioWorklet` → pull-based render, one 128-frame quantum per callback. The worklet emits stats on a timer; the main thread only forwards bytes and reports them. Decode + resample run at **write time**, which is what makes mid-stream re-`configure()` safe (below). Pure DSP (`decode.ts`, `resample.ts`, `ring-buffer.ts`) has no DOM or Node imports so it runs in the worklet and in node tests unchanged.

| Constant | Value | Rationale |
|---|---|---|
| `PREROLL_MS` | 750 | Output stays silent until this much decoded audio is buffered at start. Handoff hypothesis 0.5–1.5 s; starting at the midpoint, tuned against real Lyria jitter later. |
| `REPRIME_MS` | 300 | After an underrun, re-prime with less than the initial preroll — recovering quickly beats deep padding. |
| `RING_CAPACITY_MS` | 20 000 | R9: Lyria generates "as fast as possible", so bursts are the normal case. 20 s absorbs them; past capacity the ring drops the **oldest** frames — stale audio is steer latency against the 5–15 s target. |
| `STATS_INTERVAL_MS` | 100 | Worklet→main stats cadence. Fine enough for D's audible-blend estimate, cheap over `postMessage`. |
| `PENDING_CHUNK_LIMIT` | 256 | Main-thread queue while init/configure is pending (e.g. chunks arrive before the Start gesture). Bounds memory; oldest dropped beyond it. |

(`RENDER_QUANTUM_FRAMES`, `CHANNELS`, `BYTES_PER_*`, `DEFAULT_SAMPLE_RATE_HZ` live beside these in `src/audio/constants.ts`.)

## Re-`ready` handling

Per protocol, `ready` may be re-sent after `reconnecting`. `configure(audio)` is re-callable mid-stream with no reset: because resampling happens at write time, everything already in the ring was converted under the old rate and keeps playing untouched; only chunks decoded after re-configure use the new source rate. No drain, no audible cut, no discarded buffer.

## Mock mode (B's dev path until A+D land)

- `MockPcmGenerator` (`src/audio`): seeded mulberry32 RNG, **4 presets** (`dusk`, `glass`, `ember`, `tide`), paced emission — and a `splitOdd` option that makes every 7th chunk **deliberately end mid-frame** so the byte assembler gets exercised in mock sessions, not just against real Lyria quirks.
- `MockMusicSessionController` (`src/ui`): implements `MusicSessionController`; paces generation to stay **~1.2 s ahead** of realtime, simulates `steerDelayMs` = 1 s before a vote audibly lands, and emits an idle nudge every **45 s** (the handoff's no-vote evolution cadence).
- `App.tsx` seam: the mock is constructed behind `playerFactory`/`generatorFactory` with a marked comment directly above it — D's swap is a one-line replace of the class with the real session controller from `src/controller/index.ts`.

## What A's R2/R9 findings changed

- **R2 (48 kHz):** `DEFAULT_SAMPLE_RATE_HZ = 48000`, and the rate is never assumed — `configure()` takes the verified `ready.audio.sampleRateHz` and resamples if the `AudioContext` disagrees.
- **R9 (bursts):** the ring is sized for bursting, not gentle underruns (see `RING_CAPACITY_MS` above); `droppedFrames` is reported so we can see eviction happening rather than guessing.
- **Pacing is A's job:** whether the relay paces bursts to ≤2 s lead is A's run-ahead decision. The player accepts paced *or* bursty input and only promises to report `bufferedMs`/underruns/drops honestly.

## Heads-up messages for the team

- **D:** Your real controller must be structurally `MusicSessionController` (`src/ui/contracts.ts`). `subscribe` **must emit the current state synchronously on subscribe** — the UI relies on it for first paint. `PCMPlayer` is `createPCMPlayer()` from `src/audio/index.ts`; `configure()` may re-arrive with a *new* rate after reconnect — call it again, buffered audio is unaffected. `getStats()`/`getBufferedDurationMs()` expose `bufferedMs` for your audible-blend estimate — subtract it from ramp progress when snapshotting what the listener heard.
- **A:** The player takes paced or bursty binary PCM. Past `RING_CAPACITY_MS` (20 s) the ring drops the **oldest** frames and counts `droppedFrames`. If the smoke test shows sustained bursts, prefer relay pacing — every second buffered is a second added to steer latency against the 5–15 s downvote target.

## Verification results (2026-10-17)

- `pnpm typecheck` → clean repo-wide.
- `pnpm exec vitest run` → **112/112 pass, 11 files** (audio 67: decode 14, ring-buffer 10, resample 11, worklet-core 9, pcm-player 12, mock-generator 11; ui 41: mock-controller 13, PlayerScreen 15, StatusChip 9, ThumbsControls 4; App 4).
- `pnpm build` → clean; `pcm-worklet` emitted as a separate asset.
- Live smoke (`pnpm exec vite` + Playwright, desktop Chromium): page loads → "start listening" click → status `playing` (worklet registered, node connected, mock PCM pumping) → thumbs up/down click without lockout, never `disabled` → canvas visualizer animating → "end session" → `stopped` → pre-start view returns with "session ended". Zero console errors after the favicon fix.

### Worklet gotcha found in smoke (team heads-up)

Chrome **resolves `audioWorklet.addModule()` even when the module throws during evaluation** — verified empirically. Our processor initially `extends AudioWorkletProcessorBase` (a `declare`d-only name), which threw `ReferenceError` inside the worklet scope; `addModule` still resolved and the failure only surfaced as "node name 'sway-pcm-player' is not defined" at `new AudioWorkletNode`. Fixed by extending the real global `AudioWorkletProcessor`. Lesson: a resolving `addModule` does **not** prove the processor registered — the first end-to-end check must construct the node.

## Deferred

- Mobile device verification — deferred with A's localhost decision; code stays responsive meanwhile.
- `pnpm dev` end-to-end — needs A's `server/index.ts`; until then `pnpm exec vite` + mock mode.
- Real-PCM end-to-end playback — needs A's relay (or its mock stream) plus D's controller; verified only via mocked boundaries so far.
