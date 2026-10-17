/**
 * Live smoke test for Google Lyria RealTime (`models/lyria-realtime-exp`).
 *
 *   pnpm smoke                          # 12-min single session, sampleRateHz 48000
 *   pnpm smoke -- --rate none           # same, without sampleRateHz
 *   pnpm smoke -- --rate 44100 --duration 90
 *   pnpm smoke -- --parallel 3          # concurrency probe (~20 s, no WAV)
 *
 * Writes smoke.wav, events.jsonl and report.md into the out dir. Ctrl-C still
 * finalizes the WAV and writes the report. See docs/part-a-plan.md "Smoke test".
 *
 * Security: the SDK puts the API key in the WebSocket URL. This script never
 * logs raw ErrorEvent/CloseEvent objects or URLs; every externally sourced
 * string is scrubbed of the key before it is printed or written.
 */
import { mkdirSync, closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  GoogleGenAI,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai';
import { parseArgs, USAGE, type SmokeArgs } from './smoke/args.ts';
import {
  byteOrderScores,
  byteswap16,
  pcmDurationSec,
  resolveFormat,
  type ResolvedFormat,
} from './smoke/audio-format.ts';
import { burstRatio, fmtOffset } from './smoke/metrics.ts';
import { errorMessage, makeScrubber } from './smoke/redact.ts';
import {
  renderProbeReport,
  renderSingleReport,
  type ChunkRecord,
  type CloseRecord,
  type NoticeRecord,
  type ProbeSessionRecord,
  type SteerRecord,
  type TickRecord,
} from './smoke/report.ts';
import { WavFileWriter } from './smoke/wav.ts';

const MODEL = 'models/lyria-realtime-exp';
const CONNECT_TIMEOUT_MS = 15_000;
const SETUP_TIMEOUT_MS = 15_000;
const TICK_MS = 10_000;
const PROBE_WINDOW_SEC = 20;
const SMALL_STEER_AT_MS = 60_000;
const LARGE_STEER_AT_MS = 120_000;
const KNOWN_KEYS = new Set(['setupComplete', 'serverContent', 'filteredPrompt']);

type Prompt = { text: string; weight: number };

const INITIAL_PROMPTS: Prompt[] = [
  { text: 'dreamy ambient pads', weight: 0.8 },
  { text: 'soft felt piano', weight: 0.6 },
  { text: 'sparse, spacious texture', weight: 0.4 },
];
const SMALL_STEER: Prompt[] = [
  { text: 'dreamy ambient pads', weight: 0.8 },
  { text: 'soft felt piano', weight: 0.9 },
  { text: 'sparse, spacious texture', weight: 0.4 },
];
const LARGE_STEER: Prompt[] = [
  { text: 'upbeat jazz trio with brushed drums', weight: 1.0 },
  { text: 'walking upright bass', weight: 0.7 },
  { text: 'energetic', weight: 0.5 },
];

// ---------------------------------------------------------------------------
// Startup checks (fail fast before touching the network or the filesystem)
// ---------------------------------------------------------------------------

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`smoke-lyria: ${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}
const args: SmokeArgs = parsed.args;
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const apiKey = (process.env['GEMINI_API_KEY'] ?? '').trim();
if (apiKey === '') {
  console.error(
    [
      'smoke-lyria: GEMINI_API_KEY is not set.',
      '',
      '  1. Create a key at https://aistudio.google.com/apikey',
      '  2. cp .env.example .env   and set GEMINI_API_KEY=<your key>',
      '     (pnpm smoke loads .env automatically; or export GEMINI_API_KEY in your shell)',
      '  3. pnpm smoke            (add -- --help for options)',
    ].join('\n'),
  );
  process.exit(1);
}

const scrub = makeScrubber(apiKey);
const t0 = performance.now();
const now = (): number => performance.now() - t0;
const startedAtIso = new Date().toISOString();
const outDir = resolve(args.outDir ?? join('smoke-out', startedAtIso.replace(/[:.]/g, '-')));
mkdirSync(outDir, { recursive: true });

const musicConfig: Record<string, unknown> = { bpm: 90, density: 0.4, brightness: 0.5, guidance: 4.0 };
if (args.rate !== 'none') musicConfig['sampleRateHz'] = args.rate;

// ---------------------------------------------------------------------------
// Logging (every line is scrubbed)
// ---------------------------------------------------------------------------

const eventsFd = openSync(join(outDir, 'events.jsonl'), 'w');
let eventsOpen = true;

function logEvent(type: string, data: Record<string, unknown> = {}): void {
  if (!eventsOpen) return;
  const line = JSON.stringify({ t: Math.round(now()), wall: new Date().toISOString(), type, ...data });
  writeSync(eventsFd, `${scrub(line)}\n`);
}

function say(msg: string): void {
  console.log(scrub(`[${fmtOffset(now()).padStart(6)}] ${msg}`));
}

function warn(msg: string): void {
  console.error(scrub(`[${fmtOffset(now()).padStart(6)}] ${msg}`));
}

/** JSON-ish preview of an unknown value, scrubbed and truncated. */
function preview(value: unknown, max = 300): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = `[unserializable ${typeof value}]`;
  }
  s = scrub(s);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Only code/reason/message are read from socket events — never the event or its target. */
function describeErrorEvent(e: ErrorEvent): string {
  const parts: string[] = [];
  if (typeof e.message === 'string' && e.message !== '') parts.push(e.message);
  const inner: unknown = e.error;
  if (inner instanceof Error && inner.message !== e.message) parts.push(inner.message);
  return scrub(parts.join(' | ') || 'unknown socket error');
}

function closeInfo(e: CloseEvent): { code: number; reason: string } {
  return { code: typeof e.code === 'number' ? e.code : -1, reason: scrub(typeof e.reason === 'string' ? e.reason : '') };
}

process.on('unhandledRejection', (reason) => {
  warn(`unhandled rejection: ${scrub(errorMessage(reason))}`);
  logEvent('unhandled_rejection', { message: errorMessage(reason) });
});

// ---------------------------------------------------------------------------
// Session plumbing
// ---------------------------------------------------------------------------

interface SessionHooks {
  onMessage: (msg: LiveMusicServerMessage) => void;
  onError: (message: string) => void;
  onClose: (info: { code: number; reason: string }) => void;
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${what} timed out after ${timeoutMs} ms`)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        res(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        rej(err instanceof Error ? err : new Error(errorMessage(err)));
      },
    );
  });
}

/**
 * Connect and resolve on socket open. Rejects if the socket errors/closes
 * before opening (the SDK's own promise would hang forever in that case).
 */
async function openSession(ai: GoogleGenAI, hooks: SessionHooks): Promise<LiveMusicSession> {
  let opened = false;
  let rejectEarly: (err: Error) => void = () => {};
  const early = new Promise<never>((_, rej) => {
    rejectEarly = rej;
  });
  const connecting = ai.live.music.connect({
    model: MODEL,
    callbacks: {
      onmessage: (msg) => hooks.onMessage(msg),
      onerror: (e) => {
        const message = describeErrorEvent(e);
        hooks.onError(message);
        if (!opened) rejectEarly(new Error(`socket error before open: ${message}`));
      },
      onclose: (e) => {
        const info = closeInfo(e);
        hooks.onClose(info);
        if (!opened) rejectEarly(new Error(`socket closed before open: code=${info.code} reason="${info.reason}"`));
      },
    },
  });
  const session = await withTimeout(Promise.race([connecting, early]), CONNECT_TIMEOUT_MS, 'connect');
  opened = true;
  return session;
}

function sendConfig(session: LiveMusicSession): Promise<void> {
  // sampleRateHz is not in the SDK type; the SDK passes the object through as-is.
  return session.setMusicGenerationConfig({ musicGenerationConfig: musicConfig as LiveMusicGenerationConfig });
}

function closeQuietly(session: LiveMusicSession | undefined): void {
  if (!session) return;
  try {
    session.stop();
  } catch {
    // socket may already be gone
  }
  try {
    session.close();
  } catch {
    // ignore
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

function extraKeys(msg: LiveMusicServerMessage): string[] {
  return Object.keys(msg).filter((k) => !KNOWN_KEYS.has(k));
}

// ---------------------------------------------------------------------------
// Single-session run
// ---------------------------------------------------------------------------

async function runSingle(ai: GoogleGenAI): Promise<void> {
  const chunks: ChunkRecord[] = [];
  const ticks: TickRecord[] = [];
  const steers: SteerRecord[] = [];
  const notices: NoticeRecord[] = [];
  const mimeTypes = new Map<string, number>();
  const unknownKeys = new Map<string, number>();
  const timers: NodeJS.Timeout[] = [];
  let connectedAtMs: number | undefined;
  let setupCompleteAtMs: number | undefined;
  let playAtMs: number | undefined;
  let firstAudioAtMs: number | undefined;
  let format: ResolvedFormat | undefined;
  let swapBytes = false;
  let byteOrderNote: string | undefined;
  let audioSec = 0;
  let lastTickAudioSec = 0;
  let wav: WavFileWriter | undefined;
  let session: LiveMusicSession | undefined;
  let closeRec: CloseRecord | undefined;
  let closingByClient = false;
  let finished = false;
  const setupDone = deferred();
  const wavPath = join(outDir, 'smoke.wav');

  const notice = (kind: string, detail: string): void => {
    const rec = { atMs: now(), kind, detail: scrub(detail) };
    notices.push(rec);
    warn(`${kind}: ${rec.detail}`);
    logEvent('notice', { kind, detail: rec.detail });
  };

  const onAudio = (b64: string, mimeType: string | undefined): void => {
    const at = now();
    const raw = Buffer.from(b64, 'base64');
    mimeTypes.set(mimeType ?? '(none)', (mimeTypes.get(mimeType ?? '(none)') ?? 0) + 1);
    if (mimeTypes.get(mimeType ?? '(none)') === 1) {
      say(`new mimeType: ${mimeType === undefined ? '(none)' : `"${mimeType}"`}`);
      logEvent('mime_type', { mimeType: mimeType ?? null });
    }
    const chunkFormat = resolveFormat(mimeType);
    if (!format) {
      format = chunkFormat;
      say(`audio format: ${format.note}`);
      logEvent('format', { note: format.note, sampleRate: format.sampleRate, channels: format.channels });
    } else if (chunkFormat.sampleRate !== format.sampleRate || chunkFormat.channels !== format.channels) {
      notice('format_change', `chunk format ${chunkFormat.note} differs from WAV format ${format.note}; WAV keeps the first format`);
    }
    if (byteOrderNote === undefined && raw.length >= 4 * 4800) {
      const { le, be } = byteOrderScores(raw, format.channels);
      swapBytes = be * 4 < le;
      byteOrderNote = `mean |Δsample| LE=${le.toFixed(0)} BE=${be.toFixed(0)} → ${swapBytes ? 'BIG-endian detected, WAV is byte-swapped to LE' : 'little-endian (as documented)'}`;
      say(`byte order: ${byteOrderNote}`);
      logEvent('byte_order', { le, be, swapped: swapBytes });
    }
    const durSec = pcmDurationSec(raw.length, format);
    if (firstAudioAtMs === undefined) {
      firstAudioAtMs = at;
      say(`first audio: ${raw.length} B (${durSec.toFixed(3)} s) — ${Math.round(at - (playAtMs ?? at))} ms after play()`);
    }
    audioSec += durSec;
    chunks.push({ atMs: at, bytes: raw.length, mimeType, durSec });
    logEvent('chunk', { bytes: raw.length, durSec: Number(durSec.toFixed(4)), mimeType: mimeType ?? null, audioSec: Number(audioSec.toFixed(3)) });
    if (!wav) wav = new WavFileWriter(wavPath, format);
    wav.append(swapBytes ? byteswap16(raw) : raw);
  };

  const onMessage = (msg: LiveMusicServerMessage): void => {
    if (msg.setupComplete !== undefined && setupCompleteAtMs === undefined) {
      setupCompleteAtMs = now();
      say(`setupComplete (${Math.round(setupCompleteAtMs)} ms)`);
      logEvent('setup_complete');
      setupDone.resolve();
    }
    const sc = msg.serverContent;
    if (sc) {
      for (const chunk of sc.audioChunks ?? []) {
        if (typeof chunk.data === 'string' && chunk.data !== '') onAudio(chunk.data, chunk.mimeType);
        else notice('empty_chunk', `audio chunk without data (mimeType ${chunk.mimeType ?? '(none)'})`);
      }
      const extraSc = Object.keys(sc).filter((k) => k !== 'audioChunks');
      for (const k of extraSc) {
        const key = `serverContent.${k}`;
        unknownKeys.set(key, (unknownKeys.get(key) ?? 0) + 1);
        notice('unknown_field', `${key} = ${preview((sc as Record<string, unknown>)[k])}`);
      }
    }
    if (msg.filteredPrompt) {
      notice('filteredPrompt', `"${msg.filteredPrompt.text ?? ''}" — ${msg.filteredPrompt.filteredReason ?? '(no reason)'}`);
    }
    for (const k of extraKeys(msg)) {
      unknownKeys.set(k, (unknownKeys.get(k) ?? 0) + 1);
      notice(k === 'warning' ? 'warning' : 'unknown_field', `${k} = ${preview((msg as unknown as Record<string, unknown>)[k])}`);
    }
  };

  const writeReport = (endReason: string): void => {
    const report = renderSingleReport({
      startedAtIso,
      outDir,
      model: MODEL,
      rateRequested: args.rate,
      durationSec: args.durationSec,
      endReason,
      endedAtMs: now(),
      connectedAtMs,
      setupCompleteAtMs,
      playAtMs,
      firstAudioAtMs,
      formatNote: format?.note,
      byteOrderNote,
      mimeTypes,
      chunks,
      ticks,
      steers,
      notices,
      unknownKeys,
      close: closeRec,
      wavPath: wav ? wavPath : undefined,
      wavSeconds: wav && format ? pcmDurationSec(wav.bytesWritten, format) : 0,
      initialPrompts: INITIAL_PROMPTS,
      config: musicConfig,
    });
    writeFileSync(join(outDir, 'report.md'), scrub(report));
  };

  /** Synchronous finalization so it is safe from SIGINT. */
  const finish = (endReason: string, exitCode = 0): void => {
    if (finished) return;
    finished = true;
    for (const t of timers) clearTimeout(t);
    logEvent('end', { reason: endReason });
    if (session && !closeRec) {
      closingByClient = true;
      closeQuietly(session);
    }
    wav?.finalize();
    writeReport(endReason);
    eventsOpen = false;
    closeSync(eventsFd);
    say(`ended (${endReason}). audio ${audioSec.toFixed(1)} s in ${chunks.length} chunks.`);
    say(`report: ${join(outDir, 'report.md')}`);
    if (wav) say(`wav:    ${wavPath}`);
    say(`events: ${join(outDir, 'events.jsonl')}`);
    // Give the close frame a moment to go out, then exit.
    setTimeout(() => process.exit(exitCode), 300).unref();
  };

  let sigints = 0;
  process.on('SIGINT', () => {
    sigints++;
    if (sigints > 1) process.exit(130);
    say('SIGINT — finalizing WAV and report (Ctrl-C again to force quit)');
    finish('sigint', 130);
  });

  const tick = (): void => {
    if (finished) return;
    const at = now();
    const cumulativeRatio = playAtMs === undefined ? null : burstRatio(audioSec, (at - playAtMs) / 1000);
    const windowRatio = burstRatio(audioSec - lastTickAudioSec, TICK_MS / 1000);
    const leadSec = firstAudioAtMs === undefined ? null : audioSec - (at - firstAudioAtMs) / 1000;
    lastTickAudioSec = audioSec;
    ticks.push({ atMs: at, chunks: chunks.length, audioSec, cumulativeRatio, windowRatio, leadSec });
    logEvent('tick', { chunks: chunks.length, audioSec, cumulativeRatio, windowRatio, leadSec });
    wav?.flushHeader();
    const f = (n: number | null): string => (n === null ? '  —  ' : n.toFixed(2));
    const lastGap = chunks.length >= 2 ? Math.round((chunks[chunks.length - 1]?.atMs ?? 0) - (chunks[chunks.length - 2]?.atMs ?? 0)) : 0;
    const burst = windowRatio !== null && windowRatio > 1.1 ? '  BURST' : '';
    say(
      `chunks=${chunks.length} audio=${audioSec.toFixed(1)}s cum=${f(cumulativeRatio)} win=${f(windowRatio)} lead=${leadSec === null ? '—' : `${leadSec >= 0 ? '+' : ''}${leadSec.toFixed(1)}s`} lastGap=${lastGap}ms notices=${notices.length}${burst}`,
    );
  };

  say(`out dir: ${outDir}`);
  say(`connecting to ${MODEL} (sampleRateHz: ${args.rate}, duration: ${args.durationSec} s)`);
  logEvent('start', { model: MODEL, rate: args.rate, durationSec: args.durationSec, config: musicConfig });

  try {
    session = await openSession(ai, {
      onMessage,
      onError: (message) => notice('socket_error', message),
      onClose: ({ code, reason }) => {
        closeRec = { atMs: now(), code, reason, byClient: closingByClient };
        logEvent('close', { code, reason, byClient: closingByClient });
        if (!closingByClient) {
          say(`socket closed by server: code=${code} reason="${reason}"`);
          finish('server_close', 0);
        }
      },
    });
    connectedAtMs = now();
    say(`socket open (${Math.round(connectedAtMs)} ms); waiting for setupComplete`);
    logEvent('socket_open');

    await withTimeout(setupDone.promise, SETUP_TIMEOUT_MS, 'setupComplete');
    if (finished) return;

    await session.setWeightedPrompts({ weightedPrompts: INITIAL_PROMPTS });
    logEvent('prompts', { prompts: INITIAL_PROMPTS });
    await sendConfig(session);
    logEvent('config', { config: musicConfig });
    session.play();
    playAtMs = now();
    say(`play() sent (${Math.round(playAtMs)} ms)`);
    logEvent('play');
  } catch (err) {
    notice('startup_failed', errorMessage(err));
    finish('startup_failed', 1);
    return;
  }

  const playAt = playAtMs;
  const scheduleSteer = (label: string, offsetMs: number, prompts: Prompt[]): void => {
    if (offsetMs >= args.durationSec * 1000) {
      say(`${label} steer skipped (duration < ${offsetMs / 1000} s)`);
      return;
    }
    const plannedAtMs = playAt + offsetMs;
    timers.push(
      setTimeout(() => {
        if (finished || !session) return;
        const rec: SteerRecord = { label, plannedAtMs, sentAtMs: now(), wavPositionSec: audioSec, prompts };
        steers.push(rec);
        say(`STEER ${label} → ${prompts.map((p) => `${p.text}:${p.weight}`).join(', ')} (WAV pos ${audioSec.toFixed(1)} s)`);
        logEvent('steer', { label, prompts, wavPositionSec: audioSec });
        session.setWeightedPrompts({ weightedPrompts: prompts }).catch((err: unknown) => {
          rec.error = scrub(errorMessage(err));
          notice('steer_failed', `${label}: ${rec.error}`);
        });
      }, Math.max(0, plannedAtMs - now())),
    );
  };
  scheduleSteer('small (piano 0.6→0.9)', SMALL_STEER_AT_MS, SMALL_STEER);
  scheduleSteer('large (→ jazz trio)', LARGE_STEER_AT_MS, LARGE_STEER);

  const interval = setInterval(tick, TICK_MS);
  timers.push(interval);
  timers.push(setTimeout(() => finish('duration'), Math.max(0, args.durationSec * 1000 - now())));
}

// ---------------------------------------------------------------------------
// Concurrency probe
// ---------------------------------------------------------------------------

async function runProbe(ai: GoogleGenAI, n: number): Promise<void> {
  const windowSec = Math.min(PROBE_WINDOW_SEC, args.durationSec);
  const records: ProbeSessionRecord[] = [];
  const sessions: (LiveMusicSession | undefined)[] = [];
  let finished = false;
  let closingByClient = false;

  const finish = (exitCode = 0): void => {
    if (finished) return;
    finished = true;
    closingByClient = true;
    for (const s of sessions) closeQuietly(s);
    // Wait briefly so close codes can be recorded, then write the report.
    setTimeout(() => {
      writeFileSync(join(outDir, 'report.md'), scrub(renderProbeReport({ startedAtIso, model: MODEL, rateRequested: args.rate, windowSec, sessions: records })));
      logEvent('end', { reason: 'probe_done' });
      eventsOpen = false;
      closeSync(eventsFd);
      const ok = records.filter((r) => r.firstAudioAtMs !== undefined).length;
      say(`probe done: ${ok}/${n} sessions produced audio. report: ${join(outDir, 'report.md')}`);
      process.exit(exitCode);
    }, 2000);
  };
  process.on('SIGINT', () => {
    say('SIGINT — closing sessions and writing report');
    finish(130);
  });

  say(`out dir: ${outDir}`);
  say(`concurrency probe: opening ${n} sessions (sampleRateHz: ${args.rate}), holding ${windowSec} s`);
  logEvent('probe_start', { n, windowSec, rate: args.rate });
  setTimeout(() => finish(0), windowSec * 1000);

  const runOne = async (index: number): Promise<void> => {
    const rec: ProbeSessionRecord = { index, chunks: 0, audioSec: 0, notices: [] };
    records.push(rec);
    const setupDone = deferred();
    const tag = `#${index}`;
    const note = (s: string): void => {
      const clean = scrub(s);
      rec.notices.push(clean);
      warn(`${tag} ${clean}`);
      logEvent('probe_notice', { index, detail: clean });
    };
    try {
      const session = await openSession(ai, {
        onMessage: (msg) => {
          if (msg.setupComplete !== undefined && rec.setupCompleteAtMs === undefined) {
            rec.setupCompleteAtMs = now();
            say(`${tag} setupComplete`);
            logEvent('probe_setup_complete', { index });
            setupDone.resolve();
          }
          for (const c of msg.serverContent?.audioChunks ?? []) {
            if (typeof c.data !== 'string') continue;
            const bytes = Buffer.byteLength(c.data, 'base64');
            if (rec.firstAudioAtMs === undefined) {
              rec.firstAudioAtMs = now();
              say(`${tag} first audio (mimeType ${c.mimeType ?? '(none)'})`);
              logEvent('probe_first_audio', { index, mimeType: c.mimeType ?? null });
            }
            rec.chunks++;
            rec.audioSec += pcmDurationSec(bytes, resolveFormat(c.mimeType));
          }
          if (msg.filteredPrompt) note(`filteredPrompt "${msg.filteredPrompt.text ?? ''}": ${msg.filteredPrompt.filteredReason ?? ''}`);
          for (const k of extraKeys(msg)) note(`${k} = ${preview((msg as unknown as Record<string, unknown>)[k])}`);
        },
        onError: (message) => note(`socket error: ${message}`),
        onClose: ({ code, reason }) => {
          rec.close = { atMs: now(), code, reason, byClient: closingByClient };
          logEvent('probe_close', { index, code, reason, byClient: closingByClient });
          if (!closingByClient) warn(`${tag} closed by server: code=${code} reason="${reason}"`);
        },
      });
      sessions.push(session);
      rec.connectedAtMs = now();
      if (finished) {
        closeQuietly(session);
        return;
      }
      await withTimeout(setupDone.promise, SETUP_TIMEOUT_MS, 'setupComplete');
      if (finished) return;
      await session.setWeightedPrompts({ weightedPrompts: INITIAL_PROMPTS });
      await sendConfig(session);
      session.play();
      logEvent('probe_play', { index });
    } catch (err) {
      rec.connectError = scrub(errorMessage(err));
      warn(`${tag} failed: ${rec.connectError}`);
      logEvent('probe_failed', { index, message: rec.connectError });
    }
  };

  await Promise.all(Array.from({ length: n }, (_, i) => runOne(i + 1)));
}

// ---------------------------------------------------------------------------

const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
const run = args.parallel > 1 ? runProbe(ai, args.parallel) : runSingle(ai);
run.catch((err: unknown) => {
  warn(`fatal: ${errorMessage(err)}`);
  process.exit(1);
});
