import { describe, expect, it } from 'vitest';
import { renderProbeReport, renderSingleReport, type SingleRunData } from '../../scripts/smoke/report.ts';

const base: SingleRunData = {
  startedAtIso: '2026-10-17T00:00:00.000Z',
  outDir: '/tmp/x',
  model: 'models/lyria-realtime-exp',
  rateRequested: 48000,
  durationSec: 720,
  endReason: 'server_close',
  endedAtMs: 601_000,
  connectedAtMs: 300,
  setupCompleteAtMs: 500,
  playAtMs: 700,
  firstAudioAtMs: 2700,
  formatNote: '48000 Hz (assumed)',
  byteOrderNote: 'little-endian',
  mimeTypes: new Map([['audio/l16;rate=48000;channels=2', 3]]),
  chunks: [
    { atMs: 2700, bytes: 384000, mimeType: 'audio/l16', durSec: 2 },
    { atMs: 2900, bytes: 384000, mimeType: 'audio/l16', durSec: 2 },
    { atMs: 4900, bytes: 384000, mimeType: 'audio/l16', durSec: 2 },
  ],
  ticks: [
    { atMs: 10_000, chunks: 5, audioSec: 14, cumulativeRatio: 1.5, windowRatio: 1.4, leadSec: 6 },
    { atMs: 20_000, chunks: 10, audioSec: 26, cumulativeRatio: 1.3, windowRatio: 1.2, leadSec: 8 },
    { atMs: 30_000, chunks: 15, audioSec: 38, cumulativeRatio: 1.3, windowRatio: 1.2, leadSec: 10 },
  ],
  steers: [{ label: 'small', plannedAtMs: 60_700, sentAtMs: 60_701, wavPositionSec: 64, prompts: [{ text: 'soft felt piano', weight: 0.9 }] }],
  notices: [{ atMs: 3000, kind: 'warning', detail: 'something' }],
  unknownKeys: new Map([['warning', 1]]),
  close: { atMs: 600_500, code: 1000, reason: 'cap', byClient: false },
  wavPath: '/tmp/x/smoke.wav',
  wavSeconds: 6,
  initialPrompts: [{ text: 'dreamy ambient pads', weight: 0.8 }],
  config: { bpm: 90, sampleRateHz: 48000 },
};

describe('renderSingleReport', () => {
  it('includes the key findings and steer blanks', () => {
    const md = renderSingleReport(base);
    expect(md).toContain('Sustained burst');
    expect(md).toContain('YES');
    expect(md).toContain('| first audio chunk | 2700 ms |');
    expect(md).toContain('64.0 s');
    expect(md).toContain('____');
    expect(md).toContain('by **the server**, code **1000**');
    expect(md).toContain('consistent with the reported ~10-min cap');
  });

  it('copes with a run that produced nothing', () => {
    const md = renderSingleReport({ ...base, chunks: [], ticks: [], steers: [], notices: [], close: undefined, wavPath: undefined, firstAudioAtMs: undefined, mimeTypes: new Map(), unknownKeys: new Map() });
    expect(md).toContain('none (no audio received)');
    expect(md).toContain('run ended before t=60 s');
  });
});

describe('renderProbeReport', () => {
  it('counts sessions that produced audio', () => {
    const md = renderProbeReport({
      startedAtIso: 'x',
      model: 'm',
      rateRequested: 'none',
      windowSec: 20,
      sessions: [
        { index: 1, connectedAtMs: 100, setupCompleteAtMs: 200, firstAudioAtMs: 2000, chunks: 9, audioSec: 18, notices: [] },
        { index: 2, chunks: 0, audioSec: 0, notices: [], connectError: 'socket closed before open: code=1008' },
      ],
    });
    expect(md).toContain('audio received: **1/2**');
    expect(md).toContain('connect: socket closed before open');
  });
});
