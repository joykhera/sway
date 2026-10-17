import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/smoke/args.ts';
import { burstRatio, diffs, fmtOffset, summarize, sustainedAbove } from '../../scripts/smoke/metrics.ts';
import { makeScrubber } from '../../scripts/smoke/redact.ts';

describe('burstRatio', () => {
  it('divides audio seconds by wall seconds', () => {
    expect(burstRatio(20, 10)).toBe(2);
    expect(burstRatio(10, 10)).toBe(1);
  });

  it('returns null for non-positive wall time', () => {
    expect(burstRatio(5, 0)).toBeNull();
    expect(burstRatio(5, -1)).toBeNull();
    expect(burstRatio(Number.NaN, 1)).toBeNull();
  });
});

describe('sustainedAbove', () => {
  it('needs consecutive windows above the threshold', () => {
    expect(sustainedAbove([1.2, 1.0, 1.2, 1.0, 1.2])).toBe(false);
    expect(sustainedAbove([1.0, 1.2, 1.3, 1.15, 1.0])).toBe(true);
  });

  it('treats null as a break and the threshold as exclusive', () => {
    expect(sustainedAbove([1.2, null, 1.2, 1.2])).toBe(false);
    expect(sustainedAbove([1.1, 1.1, 1.1])).toBe(false);
  });
});

describe('summarize / diffs / fmtOffset', () => {
  it('computes min/median/max/mean', () => {
    expect(summarize([5, 1, 3])).toEqual({ count: 3, min: 1, median: 3, max: 5, mean: 3 });
    expect(summarize([4, 1, 3, 2])?.median).toBe(2.5);
    expect(summarize([])).toBeNull();
  });

  it('diffs consecutive values', () => {
    expect(diffs([100, 2100, 4000])).toEqual([2000, 1900]);
    expect(diffs([1])).toEqual([]);
  });

  it('formats offsets as m:ss.s', () => {
    expect(fmtOffset(61500)).toBe('1:01.5');
    expect(fmtOffset(undefined)).toBe('—');
  });
});

describe('makeScrubber', () => {
  it('removes the key value and any key= query param', () => {
    const scrub = makeScrubber('AIzaSECRET123');
    const out = scrub('wss://host/ws?key=AIzaSECRET123&x=1 failed; also AIzaSECRET123 and ?key=other');
    expect(out).not.toContain('AIzaSECRET123');
    expect(out).not.toContain('other');
    expect(out).toContain('[REDACTED]');
  });
});

describe('parseArgs', () => {
  it('has the documented defaults', () => {
    expect(parseArgs([])).toEqual({ ok: true, args: { durationSec: 720, rate: 48000, parallel: 1, outDir: undefined, help: false } });
  });

  it('parses flags in both forms and skips a bare --', () => {
    const r = parseArgs(['--', '--duration', '90', '--rate=none', '--parallel', '3', '--out', 'x']);
    expect(r).toEqual({ ok: true, args: { durationSec: 90, rate: 'none', parallel: 3, outDir: 'x', help: false } });
  });

  it('rejects bad values and unknown flags', () => {
    expect(parseArgs(['--rate', '22050']).ok).toBe(false);
    expect(parseArgs(['--parallel', '0']).ok).toBe(false);
    expect(parseArgs(['--duration']).ok).toBe(false);
    expect(parseArgs(['--nope', '1']).ok).toBe(false);
  });
});
