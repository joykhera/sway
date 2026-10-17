# Lyria RealTime smoke report

Status: **partial**. Two 40 s runs on 2026-10-17; the 12 min run (cap, steer latency) and the concurrency probe are still to do. Fill this in from `smoke-out/<timestamp>/report.md`. Each run writes `smoke.wav`, `events.jsonl` and `report.md`.

## How to run

```sh
cp .env.example .env               # set GEMINI_API_KEY
pnpm smoke                         # 12 min, no sampleRateHz (small steer at +60 s, large at +120 s)
pnpm smoke -- --rate 44100 --duration 90
pnpm smoke -- --parallel 2         # then 3, then 5: concurrency probe, ~20 s each, no WAV
```

Ctrl-C still finalizes the WAV and writes the report.

## Runs

| Date | Who | Command | Out dir | Notes |
|---|---|---|---|---|
| 2026-10-17 | A | `pnpm smoke --duration 40` (rate 48000) | smoke-out/2026-10-17T19-52-10-837Z | Closed 1007 at 1.1 s: `Unknown name "sampleRateHz"` |
| 2026-10-17 | A | `pnpm smoke --rate none --duration 40` | smoke-out/2026-10-17T19-52-17-336Z | 36 s of clean audio, 18 chunks |
| 2026-10-17 | A | relay live mode + ws client, start/steer/stop | — | `ready` 48000/2 at 5.8 s, steer forwarded, clean dispose, key absent from logs |

## Questions this must answer

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | **Verified sample rate / channels.** What `mimeType` arrives, and does the WAV play at the correct pitch and speed? | `audio/l16;rate=48000;channels=2` on every chunk. **48 kHz stereo.** | run 19-52-17 |
| 2 | **Does `sampleRateHz: 44100` work?** Is it accepted, rejected or ignored? Does the mimeType or pitch change? | **Rejected.** Upstream closes with 1007 `Unknown name "sampleRateHz"`. Never send it (the relay doesn't). | run 19-52-10 |
| 3 | **Burst ratio.** Cumulative audio s ÷ wall s, the max lead, and whether it stays above 1.1 (which means relay pacing is needed). | **~1.0x, no run-ahead.** Cumulative 0.93, 10 s windows 1.00, steady lead 1.8 s. Relay pacing not needed. | run 19-52-17 |
| 4 | **Time to first audio** after `play()`, plus the time to `setupComplete`. | setupComplete 0.9 s after connect; first audio **3.8 s after play()** (≈4.7 s from connect). Relay `ready` at 5.8 s. | both |
| 5 | **Perceived change latency, small steer** (piano 0.6→0.9). Measure from "WAV pos at send" to the perceived change. | | |
| 6 | **Perceived change latency, large steer** (→ jazz trio). | | |
| 7 | **Session cap observed?** y/n, at what time after setupComplete, close code and reason. | | |
| 8 | **Max concurrent sessions** per key/project (try 2, 3, 5), and how a refused session fails. | | |
| 9 | **Warnings / filtered prompts / unknown fields seen.** | | |
| 10 | Chunk size and duration (min/median/max), and arrival gaps. | Every chunk **384000 B = exactly 2.0 s**; arrivals every ~2.0 s (1.4–2.7 s). | run 19-52-17 |
| 11 | Byte order. The report checks it automatically; confirm by ear. | Little-endian (auto-check LE=1328 vs BE=21511). | run 19-52-17 |

## Decisions (fill in after the runs)

- Relay sample rate: **48000 from mimeType; never send `sampleRateHz`** (it's rejected)
- Relay pacing: **not needed** (Lyria delivers at ~1x with ~1.8 s lead)
- **For B:** audio arrives in 2 s blocks every ~2 s, so a 0.5–1.5 s jitter buffer will underrun. Start playback at ≥2.5–3 s buffered (or prove a smaller buffer works).
- Reconnect before the cap: needed / not needed (proactive reconnect at ____ min)
- Relay concurrency limit (`capacity` error): ____ sessions
