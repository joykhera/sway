/**
 * scripts/smoke-lyria.ts — `pnpm smoke`
 *
 * Exercises models/lyria-realtime-exp via @google/genai's Live Music API.
 * Artifacts: smoke-out/*.pcm (raw s16le stereo), *.wav (playable), *.log
 * (per-chunk timings). Appends "## Run <iso>" to docs/lyria-smoke-report.md.
 *
 * Flags: --duration S (default 150) · --minutes M · --cap-probe (750 s, ~10-min
 * cap probe, R6) · --both (with then without sampleRateHz pass-through, R2) ·
 * --rate HZ · --sessions N (parallel concurrency probe, R10) · --help
 *
 * Needs GEMINI_API_KEY (tsx --env-file-if-exists=.env loads .env). The SDK puts
 * the key in the upstream URL (?key=) — NEVER print the key, session.conn, or
 * raw event objects; all logged strings pass through redact().
 */
import { GoogleGenAI } from '@google/genai';
import type {
  AudioChunk,
  LiveMusicGenerationConfig,
  LiveMusicServerMessage,
  LiveMusicSession,
  WeightedPrompt,
} from '@google/genai';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers';

const MODEL = 'models/lyria-realtime-exp';
const SDK_VERSION = '2.30.0';
const OUT_DIR = 'smoke-out';
const REPORT_PATH = path.join('docs', 'lyria-smoke-report.md');
const DEFAULT_RATE = 48000;
const CONNECT_TIMEOUT_MS = 30_000;

const PROMPTS_A: WeightedPrompt[] = [{ text: 'warm ambient pads', weight: 0.5 }, { text: 'soft piano', weight: 0.4 }, { text: 'sparse texture', weight: 0.3 }];
const PROMPTS_B: WeightedPrompt[] = [{ text: 'warm ambient pads', weight: 0.5 }, { text: 'soft piano', weight: 0.7 }, { text: 'sparse texture', weight: 0.3 }]; // steer#1: piano 0.4→0.7
const PROMPTS_C: WeightedPrompt[] = [{ text: 'jazz brushed drums', weight: 0.6 }, { text: 'upright bass', weight: 0.5 }, { text: 'late-night club ambience', weight: 0.3 }]; // steer#2: swap set

const USAGE = `pnpm smoke [--duration S | --minutes M | --cap-probe] [--both | --rate HZ] [--sessions N]
  --duration S   seconds per session (default 150)
  --minutes M    duration in minutes
  --cap-probe    750 s run to observe the ~10-min upstream cap
  --both         run twice: with sampleRateHz=48000 pass-through, then without
  --rate HZ      include untyped sampleRateHz in a single run
  --sessions N   run N parallel sessions (concurrency probe)`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('[smoke] missing GEMINI_API_KEY. Put it in .env (see .env.example) — tsx loads it via --env-file-if-exists — then re-run `pnpm smoke`.');
  process.exit(1);
}

let interrupted = false;
let sigintCount = 0;
process.on('SIGINT', () => {
  sigintCount += 1;
  if (sigintCount > 1) process.exit(130);
  interrupted = true;
  console.error('\n[smoke] Ctrl-C — closing session, finalizing .wav + report… (again to force-quit)');
});

const redact = (s: string): string => s.replace(/key=[^&"'\s]+/gi, 'key=REDACTED').split(API_KEY).join('REDACTED');
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const truncJson = (v: unknown): string => JSON.stringify(v)?.slice(0, 300) ?? String(v);
const fmtMs = (n: number | undefined): string => (n === undefined ? 'n/a' : `${n} ms`);

interface Opts {
  durationSec: number;
  sessions: number;
  both: boolean;
  rate?: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { durationSec: 150, sessions: 1, both: false };
  let i = 0;
  const need = (flag: string): number => {
    const v = argv[++i];
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n <= 0) {
      console.error(`[smoke] ${flag} needs a positive number, got ${v ?? 'nothing'}`);
      process.exit(2);
    }
    return n;
  };
  for (; i < argv.length; i++) {
    switch (argv[i]) {
      case '--duration': o.durationSec = need('--duration'); break;
      case '--minutes': o.durationSec = need('--minutes') * 60; break;
      case '--cap-probe': o.durationSec = 750; break;
      case '--sessions': o.sessions = need('--sessions'); break;
      case '--both': o.both = true; break;
      case '--rate': o.rate = need('--rate'); break;
      case '--help': case '-h': break;
      default:
        console.error(`[smoke] unknown flag: ${argv[i] ?? ''}\n${USAGE}`);
        process.exit(2);
    }
  }
  return o;
}

function wavHeader(dataSize: number, rate: number, channels = 2): Buffer {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); // PCM fmt chunk
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); // byteRate, blockAlign
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataSize, 40); // bits, data size
  return b;
}

async function writeWav(pcmPath: string, wavPath: string, rate: number): Promise<void> {
  const ws = createWriteStream(wavPath);
  ws.write(wavHeader((await stat(pcmPath)).size, rate));
  await pipeline(createReadStream(pcmPath), ws);
}

interface RunStats {
  label: string; cfgDesc: string;
  ok: boolean; error?: string;
  socketOpenMs?: number; setupMs?: number; firstAudioMs?: number;
  chunks: number; bytes: number; audioSec: number; audioSecFirst10: number; wallSec: number;
  rate: number; rateSource: string; mimeTypes: string[];
  warnings: string[]; filtered: string[]; closeDesc?: string; sawGoAway: boolean;
  steer1At?: string; steer2At?: string; nonAligned: number;
  pcmPath: string; wavPath?: string; logPath: string;
}

async function runSession(
  ai: GoogleGenAI, label: string, passRate: number | undefined, opts: Opts, stamp: string,
): Promise<RunStats> {
  const base = `smoke-${stamp}-${label}`;
  const pcmPath = path.join(OUT_DIR, `${base}.pcm`);
  const logPath = path.join(OUT_DIR, `${base}.log`);
  const wavPath = path.join(OUT_DIR, `${base}.wav`);
  const st: RunStats = {
    label, cfgDesc: passRate === undefined ? 'no rate field' : `sampleRateHz=${passRate} (untyped pass-through)`,
    ok: false, chunks: 0, bytes: 0, audioSec: 0, audioSecFirst10: 0, wallSec: 0,
    rate: DEFAULT_RATE, rateSource: `assumed default ${DEFAULT_RATE}`, mimeTypes: [],
    warnings: [], filtered: [], sawGoAway: false, nonAligned: 0, pcmPath, logPath,
  };
  const pcm = createWriteStream(pcmPath);
  const logf = createWriteStream(logPath);
  pcm.on('error', () => undefined);
  logf.on('error', () => undefined);
  const slog = (s: string): void => {
    console.log(`[${label}] ${s}`);
    if (logf.writable) logf.write(`[${label}] ${s}\n`);
  };

  const t0 = Date.now();
  let session: LiveMusicSession | undefined;
  let tPlay = 0;
  let closed = false;
  let sawSetup = false;
  let setupResolve: () => void = () => undefined;
  const setupP = new Promise<void>((res) => { setupResolve = res; });
  let connectFail: (e: Error) => void = () => undefined;
  const failP = new Promise<never>((_, rej) => { connectFail = rej; });
  failP.catch(() => undefined); // absorb post-race rejections

  const handleChunk = (c: AudioChunk, t: number): void => {
    if (c.mimeType && !st.mimeTypes.includes(c.mimeType)) {
      st.mimeTypes.push(c.mimeType);
      const r = Number(/rate=(\d+)/.exec(c.mimeType)?.[1]);
      if (Number.isFinite(r) && r > 0 && r !== st.rate) {
        st.rate = r;
        st.rateSource = `parsed from mimeType '${c.mimeType}'`;
        slog(`mimeType '${c.mimeType}' → sample rate ${r} Hz (was assuming ${DEFAULT_RATE})`);
      }
    }
    const buf = Buffer.from(c.data ?? '', 'base64');
    if (buf.length % 4 !== 0) st.nonAligned += 1;
    if (st.chunks === 0) {
      st.firstAudioMs = Date.now() - tPlay;
      slog(`first audio chunk at t=+${(t / 1000).toFixed(2)}s (${st.firstAudioMs} ms after play())`);
    }
    st.chunks += 1;
    st.bytes += buf.length;
    const dur = buf.length / (st.rate * 4); // s16le stereo = 4 bytes/frame
    st.audioSec += dur;
    const wall = t / 1000;
    if (wall <= 10) st.audioSecFirst10 += dur;
    if (pcm.writable) pcm.write(buf);
    slog(
      `t=+${wall.toFixed(2)}s #${st.chunks} ${buf.length}B dur=${dur.toFixed(2)}s ` +
      `cum=${st.audioSec.toFixed(1)}s burst=${(st.audioSec / Math.max(wall, 0.01)).toFixed(2)}x` +
      (c.mimeType ? ` mime=${c.mimeType}` : ''),
    );
  };

  const onMsg = (m: LiveMusicServerMessage): void => {
    const t = Date.now() - t0;
    if (m.setupComplete != null && !sawSetup) {
      sawSetup = true;
      st.setupMs = t;
      setupResolve();
    }
    const rec = m as unknown as Record<string, unknown>; // server may send untyped fields
    for (const k of ['warning', 'warnings', 'goAway', 'goaway'] as const) {
      if (rec[k] === undefined) continue;
      if (k.startsWith('go')) st.sawGoAway = true;
      else st.warnings.push(`t=+${(t / 1000).toFixed(1)}s ${k}: ${redact(truncJson(rec[k]))}`);
    }
    if (m.filteredPrompt) {
      const fp = `t=+${(t / 1000).toFixed(1)}s "${m.filteredPrompt.text ?? ''}": ${m.filteredPrompt.filteredReason ?? 'no reason'}`;
      st.filtered.push(fp);
      slog(`filteredPrompt — ${fp}`);
    }
    for (const c of m.serverContent?.audioChunks ?? []) handleChunk(c, t);
  };

  const onErr = (e: ErrorEvent): void => {
    const msg = `ws error (type=${e.type ?? '?'}): ${redact(String(e.message ?? 'no message'))}`;
    st.warnings.push(`t=+${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);
    slog(msg);
    connectFail(new Error(msg));
  };
  const onClose = (e: CloseEvent): void => {
    closed = true;
    const reason = redact(String((e as { reason?: unknown }).reason ?? ''));
    st.closeDesc = `code=${e.code} reason='${reason}' clean=${Boolean((e as { wasClean?: unknown }).wasClean)}`;
    slog(`closed at t=+${((Date.now() - t0) / 1000).toFixed(1)}s — ${st.closeDesc}`);
    connectFail(new Error(`socket closed before setup (${st.closeDesc})`));
  };

  try {
    // connect() resolves on socket open and auto-sends {setup:{model}}; the first
    // server message is setupComplete — wait for it before sending anything (R4).
    try {
      const t = setTimeout(() => connectFail(new Error('socket open timed out after 30 s')), CONNECT_TIMEOUT_MS);
      try {
        session = await Promise.race([
          ai.live.music.connect({ model: MODEL, callbacks: { onmessage: onMsg, onerror: onErr, onclose: onClose } }),
          failP,
        ]);
      } finally { clearTimeout(t); }
      st.socketOpenMs = Date.now() - t0;
      slog(`socket open at +${st.socketOpenMs} ms — awaiting setupComplete`);
      const t2 = setTimeout(() => connectFail(new Error('setupComplete not received within 30 s of open')), CONNECT_TIMEOUT_MS);
      try { await Promise.race([setupP, failP]); } finally { clearTimeout(t2); }
      slog(`setupComplete at +${st.setupMs ?? -1} ms since connect()`);
    } catch (e) {
      st.error = `connect/setup failed: ${redact(errMsg(e))}`;
      slog(st.error);
      return st;
    }

    try {
      await session.setWeightedPrompts({ weightedPrompts: PROMPTS_A });
      const cfg: LiveMusicGenerationConfig & { sampleRateHz?: number } = { temperature: 1.1, guidance: 4.0 };
      if (passRate !== undefined) cfg.sampleRateHz = passRate;
      await session.setMusicGenerationConfig({ musicGenerationConfig: cfg });
      tPlay = Date.now();
      session.play();
      slog(`play() sent (${st.cfgDesc}); prompts: ${PROMPTS_A.map((p) => `'${p.text}'@${p.weight}`).join(', ')}`);
    } catch (e) {
      st.error = `prompt/config/play send failed: ${redact(errMsg(e))}`;
      slog(st.error);
      return st;
    }

    await sleep(1500); // settle: surfaces async rejection of the config (e.g. bad field)
    if (closed) {
      st.error = `server closed right after config send — rejected untyped field? (${st.closeDesc ?? 'no close info'})`;
      slog(st.error);
      return st;
    }

    const steer1Ms = Math.min(60_000, Math.round(opts.durationSec * 400));
    const steer2Ms = Math.min(120_000, Math.round(opts.durationSec * 800));
    let steer1Done = false;
    let steer2Done = false;
    while (Date.now() - tPlay < opts.durationSec * 1000 && !interrupted && !closed) {
      const t = Date.now() - tPlay;
      if (!steer1Done && t >= steer1Ms) {
        steer1Done = true;
        try {
          await session.setWeightedPrompts({ weightedPrompts: PROMPTS_B });
          st.steer1At = `t=+${(t / 1000).toFixed(1)}s`;
          slog(`steer#1 sent at ${st.steer1At} — 'soft piano' weight 0.4→0.7`);
        } catch (e) { st.warnings.push(`steer#1 send failed: ${redact(errMsg(e))}`); }
      }
      if (!steer2Done && t >= steer2Ms) {
        steer2Done = true;
        try {
          await session.setWeightedPrompts({ weightedPrompts: PROMPTS_C });
          st.steer2At = `t=+${(t / 1000).toFixed(1)}s`;
          slog(`steer#2 sent at ${st.steer2At} — prompt swap → ${PROMPTS_C.map((p) => `'${p.text}'@${p.weight}`).join(', ')}`);
        } catch (e) { st.warnings.push(`steer#2 send failed: ${redact(errMsg(e))}`); }
      }
      await sleep(200);
    }
    st.wallSec = (Date.now() - tPlay) / 1000;
    st.ok = st.chunks > 0;
  } finally {
    try { session?.close(); } catch { /* already closed */ }
    await sleep(300); // let the close event flush into the log
    await new Promise<void>((r) => pcm.end(() => r()));
    await new Promise<void>((r) => logf.end(() => r()));
    if (st.bytes > 0) {
      try {
        await writeWav(pcmPath, wavPath, st.rate);
        st.wavPath = wavPath;
      } catch (e) { st.warnings.push(`wav write failed: ${redact(errMsg(e))}`); }
    }
  }
  return st;
}

function fmtRate(st: RunStats): string {
  const mimes = st.mimeTypes.length > 0 ? st.mimeTypes.join(', ') : 'none seen';
  return `\`${mimes}\` → using ${st.rate} Hz (${st.rateSource}); s16le stereo assumed`;
}
const steerDesc = (st: RunStats): string =>
  `${st.steer1At ? `#1 sent ${st.steer1At}` : '#1 not sent'}; ${st.steer2At ? `#2 sent ${st.steer2At}` : '#2 not sent'} — audible? see LISTEN notes below`;

function capDesc(st: RunStats): string {
  if (st.wallSec === 0) return 'never played';
  let s = `ran ${st.wallSec.toFixed(1)}s`;
  if (st.closeDesc) s += `; ${st.closeDesc}`;
  if (st.sawGoAway) s += '; goAway seen before close';
  return s;
}
function notesDesc(st: RunStats): string {
  const bits = [
    `chunks=${st.chunks}`,
    `bytes=${(st.bytes / 1e6).toFixed(2)}MB`,
    `audio ${st.audioSec.toFixed(1)}s vs wall ${st.wallSec.toFixed(1)}s (${(st.audioSec / Math.max(st.wallSec, 0.01)).toFixed(2)}x overall)`,
  ];
  if (st.nonAligned > 0) bits.push(`non-frame-aligned chunks: ${st.nonAligned}`);
  bits.push(`filteredPrompts: ${st.filtered.length > 0 ? st.filtered.join('; ') : 'none'}`);
  bits.push(`warnings: ${st.warnings.length > 0 ? st.warnings.join('; ') : 'none'}`);
  if (st.error) bits.push(`error: ${st.error}`);
  return bits.join('; ');
}

async function appendReport(results: RunStats[], opts: Opts, iso: string): Promise<void> {
  if (!existsSync(REPORT_PATH)) {
    await writeFile(REPORT_PATH, '# Lyria realtime smoke report\n\n<!-- run sections appended by `pnpm smoke` -->\n');
  }
  const streamed = results.filter((r) => r.chunks > 0).length;
  const lines: string[] = [
    `\n## Run ${iso}`,
    '',
    `Command: \`pnpm smoke ${redact(process.argv.slice(2).join(' '))}\` · model \`${MODEL}\` · @google/genai ${SDK_VERSION} · target ${opts.durationSec}s/session`,
    '',
  ];
  for (const st of results) {
    lines.push(
      `### ${st.label} — ${st.cfgDesc}`,
      '',
      '| Field | Value |',
      '|---|---|',
      `| Access verified? | ${st.setupMs !== undefined ? `yes — setupComplete at +${st.setupMs} ms` : `NO — ${st.error ?? 'no setupComplete'}`} |`,
      `| Output format/rate observed | ${fmtRate(st)} |`,
      `| Setup latency | socket open ${fmtMs(st.socketOpenMs)}; setupComplete ${fmtMs(st.setupMs)} |`,
      `| First-audio latency | ${fmtMs(st.firstAudioMs)} after play() |`,
      `| Burst ratio over first 10 s | ${st.audioSecFirst10 > 0 ? `${(st.audioSecFirst10 / 10).toFixed(2)}x` : 'n/a'} |`,
      `| Steer observed at | ${steerDesc(st)} |`,
      `| Session cap behavior | ${capDesc(st)} |`,
      `| Parallel sessions | ${opts.sessions > 1 ? `${opts.sessions} requested / ${streamed} streamed concurrently` : `n/a — sequential (${results.length} session(s), ${streamed} streamed)`} |`,
      `| Notes | ${notesDesc(st)} |`,
      '',
      `Artifacts: \`${st.pcmPath}\`${st.wavPath ? `, \`${st.wavPath}\`` : ''}, \`${st.logPath}\``,
      '',
      '**LISTEN (human fills):**',
      '- steer#1 (weight bump) audible at ≈ t=___ s? ___',
      '- steer#2 (prompt swap) audible at ≈ t=___ s? ___',
      '- gaps/glitches in the .wav? ___',
      '',
    );
  }
  await appendFile(REPORT_PATH, lines.join('\n'));
  console.log(`[smoke] report appended → ${REPORT_PATH}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir('docs', { recursive: true });
  const ai = new GoogleGenAI({ apiKey: API_KEY });
  const iso = new Date().toISOString();
  const stamp = iso.replace(/[:.]/g, '-');
  const results: RunStats[] = [];

  // hard kill-switch: never leave the process hanging past duration + slack
  const kill = setTimeout(() => {
    console.error('[smoke] kill-switch fired — still alive past duration+slack; forcing exit.');
    process.exit(process.exitCode || 1);
  }, (opts.both ? 2 : 1) * opts.durationSec * 1000 + 90_000);
  kill.unref();

  try {
    if (opts.sessions > 1) {
      const batch = await Promise.all(
        Array.from({ length: opts.sessions }, (_, i) => runSession(ai, `s${i}`, opts.rate, opts, stamp)),
      );
      results.push(...batch);
    } else if (opts.both) {
      results.push(await runSession(ai, 'a-rate48000', opts.rate ?? 48000, opts, stamp));
      if (!interrupted) results.push(await runSession(ai, 'b-norate', undefined, opts, stamp));
    } else {
      results.push(await runSession(ai, 'run', opts.rate, opts, stamp));
    }
  } finally {
    clearTimeout(kill);
    await appendReport(results, opts, iso);
  }

  const streamed = results.filter((r) => r.chunks > 0).length;
  console.log(`[smoke] done — ${streamed}/${results.length} session(s) streamed audio.`);
  if (streamed === 0) process.exitCode = 1; // connect failure ⇒ nonzero exit
}

try {
  await main();
} catch (e) {
  console.error(`[smoke] fatal: ${redact(errMsg(e))}`);
  process.exitCode = 1;
}
