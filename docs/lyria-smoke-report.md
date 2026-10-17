# Lyria realtime smoke report

Smoke harness: `pnpm smoke` → `scripts/smoke-lyria.ts` → `models/lyria-realtime-exp`
via `@google/genai`'s `ai.live.music.connect`.

Artifacts land in `smoke-out/` (gitignored):

- `*.pcm` — raw decoded audio (s16le stereo; rate per run, headerless)
- `*.wav` — same audio wrapped in a 44-byte RIFF/WAVE header, playable
- `*.log` — per-chunk timing log (byte size, decoded duration, mimeType,
  cumulative audio-seconds vs wall-seconds = burst ratio, steer timestamps)

Flags: `--duration S` · `--minutes M` · `--cap-probe` (750 s, ~10-min cap probe) ·
`--both` (with then without `sampleRateHz` pass-through) · `--rate HZ` ·
`--sessions N` (parallel concurrency probe).

**NEVER paste the API key or any `key=` URL into this file or any log.**

## Fixed fields — the script fills this table per run/session

| Field | Value |
|---|---|
| Access verified? | — |
| Output format/rate observed | — |
| Setup latency | — |
| First-audio latency | — |
| Burst ratio over first 10 s | — |
| Steer observed at | — |
| Session cap behavior | — |
| Parallel sessions | — |
| Notes | — |

## Subjective notes (human listener fills after each run)

- Did steer#1 (weight bump at ~t=60 s: `soft piano` 0.4→0.7) audibly change the mix? At what time?
- Did steer#2 (prompt swap at ~t=120 s → `jazz brushed drums`/`upright bass`) land? How long until audible?
- Gaps, glitches, or stalls anywhere in the .wav?
- `--cap-probe`: clean close or abrupt cutoff? Any `goAway` warning first?

## Aggregate findings (fill in after enough runs — feeds the relay)

- Sample rate / format to hardcode in the relay: _TBD_
- Does the untyped `sampleRateHz` pass-through error? (R2): _TBD_
- Burst ratio → does the relay need pacing? (plan §17): _TBD_
- Upstream cap: observed close code/reason + timing → reconnect cadence (R6): _TBD_
- Max parallel sessions observed (R10): _TBD_
- Filtered prompts / warnings seen: _TBD_

---

## Runs

<!-- `pnpm smoke` appends "## Run <ISO timestamp>" sections below -->

## Run 2026-10-17T20:42:16.788Z

Command: `pnpm smoke --duration 25` · model `models/lyria-realtime-exp` · @google/genai 2.30.0 · target 25s/session

### run — no rate field

| Field | Value |
|---|---|
| Access verified? | yes — setupComplete at +603 ms |
| Output format/rate observed | `audio/l16;rate=48000;channels=2` → using 48000 Hz (assumed default 48000); s16le stereo assumed |
| Setup latency | socket open 286 ms; setupComplete 603 ms |
| First-audio latency | 2888 ms after play() |
| Burst ratio over first 10 s | 0.80x |
| Steer observed at | #1 sent t=+10.0s; #2 sent t=+20.0s — audible? see LISTEN notes below |
| Session cap behavior | ran 25.0s; code=1000 reason='' clean=true |
| Parallel sessions | n/a — sequential (1 session(s), 1 streamed) |
| Notes | chunks=12; bytes=4.61MB; audio 24.0s vs wall 25.0s (0.96x overall); filteredPrompts: none; warnings: none |

Artifacts: `smoke-out\smoke-2026-10-17T20-42-16-788Z-run.pcm`, `smoke-out\smoke-2026-10-17T20-42-16-788Z-run.wav`, `smoke-out\smoke-2026-10-17T20-42-16-788Z-run.log`

**LISTEN (human fills):**
- steer#1 (weight bump) audible at ≈ t=___ s? ___
- steer#2 (prompt swap) audible at ≈ t=___ s? ___
- gaps/glitches in the .wav? ___
