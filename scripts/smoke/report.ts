/** Markdown rendering for the smoke-test report (pure: data in, string out). */
import { BURST_THRESHOLD, diffs, fmtOffset, summarize, sustainedAbove, type Summary } from './metrics.ts';

export interface ChunkRecord {
  atMs: number;
  bytes: number;
  mimeType: string | undefined;
  durSec: number;
}

export interface TickRecord {
  atMs: number;
  chunks: number;
  audioSec: number;
  /** Audio seconds / wall seconds since play(). */
  cumulativeRatio: number | null;
  /** Audio seconds received in the last window / window length. */
  windowRatio: number | null;
  /** Audio seconds received minus wall seconds since first audio. */
  leadSec: number | null;
}

export interface SteerRecord {
  label: string;
  plannedAtMs: number;
  sentAtMs: number;
  /** Seconds of audio already received when the steer was sent (= WAV position). */
  wavPositionSec: number;
  prompts: ReadonlyArray<{ text: string; weight: number }>;
  error?: string;
}

export interface NoticeRecord {
  atMs: number;
  kind: string;
  detail: string;
}

export interface CloseRecord {
  atMs: number;
  code: number;
  reason: string;
  byClient: boolean;
}

export interface SingleRunData {
  startedAtIso: string;
  outDir: string;
  model: string;
  rateRequested: number | 'none';
  durationSec: number;
  endReason: string;
  endedAtMs: number;
  connectedAtMs?: number;
  setupCompleteAtMs?: number;
  playAtMs?: number;
  firstAudioAtMs?: number;
  formatNote?: string;
  byteOrderNote?: string;
  mimeTypes: ReadonlyMap<string, number>;
  chunks: ReadonlyArray<ChunkRecord>;
  ticks: ReadonlyArray<TickRecord>;
  steers: ReadonlyArray<SteerRecord>;
  notices: ReadonlyArray<NoticeRecord>;
  unknownKeys: ReadonlyMap<string, number>;
  close?: CloseRecord;
  wavPath?: string;
  wavSeconds: number;
  initialPrompts: ReadonlyArray<{ text: string; weight: number }>;
  config: Readonly<Record<string, unknown>>;
}

const f2 = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toFixed(2));
const ms = (n: number | undefined): string => (n === undefined ? '—' : `${Math.round(n)} ms`);

function summaryRow(name: string, s: Summary | null, unit: string, digits: number): string {
  if (s === null) return `| ${name} | — | — | — | — | 0 |`;
  const v = (n: number): string => `${n.toFixed(digits)} ${unit}`;
  return `| ${name} | ${v(s.min)} | ${v(s.median)} | ${v(s.max)} | ${v(s.mean)} | ${s.count} |`;
}

function promptList(prompts: ReadonlyArray<{ text: string; weight: number }>): string {
  return prompts.map((p) => `"${p.text}" ${p.weight}`).join(', ');
}

export function renderSingleReport(d: SingleRunData): string {
  const audioSec = d.chunks.reduce((a, c) => a + c.durSec, 0);
  const arrivals = d.chunks.map((c) => c.atMs);
  const gaps = diffs(arrivals);
  const windowRatios = d.ticks.map((t) => t.windowRatio);
  const sustained = sustainedAbove(windowRatios);
  const lastTick = d.ticks[d.ticks.length - 1];
  const playWallSec = d.playAtMs === undefined ? null : (d.endedAtMs - d.playAtMs) / 1000;
  const overallRatio = playWallSec && playWallSec > 0 ? audioSec / playWallSec : null;
  const maxLead = d.ticks.reduce<number | null>((m, t) => (t.leadSec === null ? m : m === null ? t.leadSec : Math.max(m, t.leadSec)), null);

  const lines: string[] = [];
  lines.push(`# Lyria RealTime smoke run — ${d.startedAtIso}`, '');
  lines.push(`- Model: \`${d.model}\``);
  lines.push(`- sampleRateHz requested: **${d.rateRequested}**`);
  lines.push(`- Planned duration: ${d.durationSec} s; ended by **${d.endReason}** at ${fmtOffset(d.endedAtMs)} (${Math.round(d.endedAtMs)} ms)`);
  lines.push(`- Initial prompts: ${promptList(d.initialPrompts)}`);
  lines.push(`- Config sent: \`${JSON.stringify(d.config)}\``);
  lines.push(`- WAV: ${d.wavPath ? `\`${d.wavPath}\` (${audioSec.toFixed(1)} s of audio, ${d.wavSeconds.toFixed(1)} s written)` : 'none (no audio received)'}`);
  lines.push('', 'All offsets are wall-clock time since the connect call started (t=0).', '');

  lines.push('## Startup', '');
  lines.push('| Milestone | Offset |', '|---|---|');
  lines.push(`| socket open (connect resolved) | ${ms(d.connectedAtMs)} |`);
  lines.push(`| setupComplete | ${ms(d.setupCompleteAtMs)} |`);
  lines.push(`| play() sent | ${ms(d.playAtMs)} |`);
  lines.push(`| first audio chunk | ${ms(d.firstAudioAtMs)} |`);
  const ttfaFromPlay = d.firstAudioAtMs !== undefined && d.playAtMs !== undefined ? d.firstAudioAtMs - d.playAtMs : undefined;
  lines.push(`| first audio after play() | ${ms(ttfaFromPlay)} |`, '');

  lines.push('## Audio format', '');
  lines.push(`- Format used for durations/WAV: ${d.formatNote ?? '— (no audio)'}`);
  lines.push(`- Byte-order check: ${d.byteOrderNote ?? '—'}`);
  lines.push('- Distinct mimeTypes seen:');
  if (d.mimeTypes.size === 0) lines.push('  - (none)');
  for (const [mt, n] of d.mimeTypes) lines.push(`  - \`${mt}\` × ${n}`);
  lines.push('');

  lines.push('## Throughput / burst ratio', '');
  lines.push(`- Total: ${d.chunks.length} chunks, ${audioSec.toFixed(2)} s audio over ${playWallSec === null ? '—' : playWallSec.toFixed(1)} s wall since play() → overall ratio **${f2(overallRatio)}**`);
  lines.push(`- Max lead (audio received − wall time since first audio): **${maxLead === null ? '—' : `${maxLead.toFixed(2)} s`}**`);
  lines.push(`- Sustained burst (window ratio > ${BURST_THRESHOLD} for ≥3 consecutive 10 s windows): **${sustained ? 'YES — relay pacing needed' : 'no'}**`);
  if (lastTick) lines.push(`- Final cumulative ratio: ${f2(lastTick.cumulativeRatio)}`);
  lines.push('', '| t | chunks | audio s | cumulative ratio | 10 s window ratio | lead s |', '|---|---|---|---|---|---|');
  for (const t of d.ticks) {
    const flag = t.windowRatio !== null && t.windowRatio > BURST_THRESHOLD ? ' ⚠' : '';
    lines.push(`| ${fmtOffset(t.atMs)} | ${t.chunks} | ${t.audioSec.toFixed(1)} | ${f2(t.cumulativeRatio)} | ${f2(t.windowRatio)}${flag} | ${f2(t.leadSec)} |`);
  }
  lines.push('');

  lines.push('## Chunks', '');
  lines.push('| Metric | min | median | max | mean | n |', '|---|---|---|---|---|---|');
  lines.push(summaryRow('size', summarize(d.chunks.map((c) => c.bytes)), 'B', 0));
  lines.push(summaryRow('duration', summarize(d.chunks.map((c) => c.durSec)), 's', 3));
  lines.push(summaryRow('gap between arrivals', summarize(gaps), 'ms', 0));
  const steadyGaps = gaps.filter((_, i) => (arrivals[i + 1] ?? 0) - (d.firstAudioAtMs ?? 0) > 15000);
  lines.push(summaryRow('gap (after first 15 s of audio)', summarize(steadyGaps), 'ms', 0), '');

  lines.push('## Steers — listen to the WAV and fill in the blanks', '');
  lines.push('"WAV pos" = seconds of audio already received when the steer was sent. Audio before that point was generated before the steer, so the change can only be heard after it. Latency = perceived − WAV pos.', '');
  lines.push('| Steer | Planned | Sent (wall) | WAV pos at send | Prompts | Perceived change at (WAV time) | Latency |', '|---|---|---|---|---|---|---|');
  if (d.steers.length === 0) lines.push('| (none — run ended before t=60 s) | | | | | | |');
  for (const s of d.steers) {
    lines.push(
      `| ${s.label}${s.error ? ` (error: ${s.error})` : ''} | ${fmtOffset(s.plannedAtMs)} | ${fmtOffset(s.sentAtMs)} | ${s.wavPositionSec.toFixed(1)} s | ${promptList(s.prompts)} | ____ | ____ |`,
    );
  }
  lines.push('');

  lines.push('## Warnings, filtered prompts, errors', '');
  if (d.notices.length === 0) lines.push('None.');
  for (const n of d.notices) lines.push(`- ${fmtOffset(n.atMs)} **${n.kind}**: ${n.detail}`);
  lines.push('');
  lines.push('Unknown top-level message keys:');
  if (d.unknownKeys.size === 0) lines.push('- (none)');
  for (const [k, n] of d.unknownKeys) lines.push(`- \`${k}\` × ${n}`);
  lines.push('');

  lines.push('## Session end / cap', '');
  if (d.close) {
    lines.push(
      `- Socket closed at ${fmtOffset(d.close.atMs)} (${Math.round(d.close.atMs)} ms) by **${d.close.byClient ? 'this client' : 'the server'}**, code **${d.close.code}**, reason "${d.close.reason}"`,
    );
    if (!d.close.byClient) {
      const sinceSetup = d.setupCompleteAtMs === undefined ? undefined : d.close.atMs - d.setupCompleteAtMs;
      lines.push(`- Server-initiated close ${fmtOffset(sinceSetup)} after setupComplete — ${sinceSetup !== undefined && sinceSetup > 540000 && sinceSetup < 660000 ? 'consistent with the reported ~10-min cap' : 'compare with the reported ~10-min cap'}`);
    }
  } else {
    lines.push('- No close event recorded (process ended first).');
  }
  if (d.endReason !== 'server_close' && d.durationSec >= 660 && (d.close?.byClient ?? true)) {
    lines.push('- Session survived the planned duration without a server close → no cap observed in this run.');
  }
  lines.push('');
  return lines.join('\n');
}

export interface ProbeSessionRecord {
  index: number;
  connectedAtMs?: number;
  setupCompleteAtMs?: number;
  firstAudioAtMs?: number;
  chunks: number;
  audioSec: number;
  notices: string[];
  connectError?: string;
  close?: CloseRecord;
}

export interface ProbeData {
  startedAtIso: string;
  model: string;
  rateRequested: number | 'none';
  windowSec: number;
  sessions: ReadonlyArray<ProbeSessionRecord>;
}

export function renderProbeReport(d: ProbeData): string {
  const ok = d.sessions.filter((s) => s.firstAudioAtMs !== undefined).length;
  const setup = d.sessions.filter((s) => s.setupCompleteAtMs !== undefined).length;
  const lines: string[] = [];
  lines.push(`# Lyria RealTime concurrency probe — ${d.startedAtIso}`, '');
  lines.push(`- Model: \`${d.model}\`, sampleRateHz requested: ${d.rateRequested}`);
  lines.push(`- Opened **${d.sessions.length}** sessions concurrently; held for ${d.windowSec} s`);
  lines.push(`- setupComplete: **${setup}/${d.sessions.length}**, audio received: **${ok}/${d.sessions.length}**`, '');
  lines.push('| # | socket open | setupComplete | first audio | chunks | audio s | close | errors / notices |', '|---|---|---|---|---|---|---|---|');
  for (const s of d.sessions) {
    const close = s.close ? `${s.close.code} "${s.close.reason}" @${fmtOffset(s.close.atMs)} (${s.close.byClient ? 'client' : 'server'})` : '—';
    const notes = [s.connectError ? `connect: ${s.connectError}` : '', ...s.notices].filter((x) => x !== '').join('; ');
    lines.push(
      `| ${s.index} | ${ms(s.connectedAtMs)} | ${ms(s.setupCompleteAtMs)} | ${ms(s.firstAudioAtMs)} | ${s.chunks} | ${s.audioSec.toFixed(1)} | ${close} | ${notes || '—'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
