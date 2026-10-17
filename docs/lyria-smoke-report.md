# Lyria RealTime smoke report

Status: **not run yet**. Fill this in from `smoke-out/<timestamp>/report.md`. Each run writes `smoke.wav`, `events.jsonl` and `report.md`.

## How to run

```sh
cp .env.example .env               # set GEMINI_API_KEY
pnpm smoke                         # 12 min, sampleRateHz 48000 (small steer at +60 s, large at +120 s)
pnpm smoke -- --rate none          # 12 min, no sampleRateHz
pnpm smoke -- --rate 44100 --duration 90
pnpm smoke -- --parallel 2         # then 3, then 5: concurrency probe, ~20 s each, no WAV
```

Ctrl-C still finalizes the WAV and writes the report.

## Runs

| Date | Who | Command | Out dir | Notes |
|---|---|---|---|---|
| | | | | |

## Questions this must answer

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | **Verified sample rate / channels.** What `mimeType` arrives, and does the WAV play at the correct pitch and speed? | | |
| 2 | **Does `sampleRateHz: 44100` work?** Is it accepted, rejected or ignored? Does the mimeType or pitch change? | | |
| 3 | **Burst ratio.** Cumulative audio s ÷ wall s, the max lead, and whether it stays above 1.1 (which means relay pacing is needed). | | |
| 4 | **Time to first audio** after `play()`, plus the time to `setupComplete`. | | |
| 5 | **Perceived change latency, small steer** (piano 0.6→0.9). Measure from "WAV pos at send" to the perceived change. | | |
| 6 | **Perceived change latency, large steer** (→ jazz trio). | | |
| 7 | **Session cap observed?** y/n, at what time after setupComplete, close code and reason. | | |
| 8 | **Max concurrent sessions** per key/project (try 2, 3, 5), and how a refused session fails. | | |
| 9 | **Warnings / filtered prompts / unknown fields seen.** | | |
| 10 | Chunk size and duration (min/median/max), and arrival gaps. | | |
| 11 | Byte order. The report checks it automatically; confirm by ear. | | |

## Decisions (fill in after the runs)

- Relay sample rate: ____ (and whether we send `sampleRateHz` at all)
- Relay pacing: needed / not needed (lead budget ≤ ____ s)
- Reconnect before the cap: needed / not needed (proactive reconnect at ____ min)
- Relay concurrency limit (`capacity` error): ____ sessions
