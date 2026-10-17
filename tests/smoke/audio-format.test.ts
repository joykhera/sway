import { describe, expect, it } from 'vitest';
import {
  byteOrderScores,
  byteswap16,
  parseAudioMimeType,
  pcmDurationSec,
  resolveFormat,
} from '../../scripts/smoke/audio-format.ts';

describe('parseAudioMimeType', () => {
  it('returns undefined for missing or empty values', () => {
    expect(parseAudioMimeType(undefined)).toBeUndefined();
    expect(parseAudioMimeType('  ')).toBeUndefined();
  });

  it('parses rate and channels', () => {
    const p = parseAudioMimeType('audio/L16;rate=44100;channels=1');
    expect(p).toMatchObject({ baseType: 'audio/l16', sampleRate: 44100, channels: 1 });
  });

  it('accepts alternative keys, whitespace, quotes and case', () => {
    const p = parseAudioMimeType('Audio/PCM; Sample_Rate="48000" ; CHANNELS=2');
    expect(p).toMatchObject({ baseType: 'audio/pcm', sampleRate: 48000, channels: 2 });
  });

  it('ignores invalid numbers and stray params', () => {
    const p = parseAudioMimeType('audio/pcm;rate=abc;channels=-2;codec=pcm;junk');
    expect(p?.sampleRate).toBeUndefined();
    expect(p?.channels).toBeUndefined();
    expect(p?.params['codec']).toBe('pcm');
  });
});

describe('resolveFormat', () => {
  it('falls back to 48 kHz stereo 16-bit and says so', () => {
    const f = resolveFormat(undefined);
    expect(f).toMatchObject({ sampleRate: 48000, channels: 2, bitsPerSample: 16, rateSource: 'assumed', channelsSource: 'assumed' });
    expect(f.note).toContain('assumed');
  });

  it('uses mimeType values when present', () => {
    const f = resolveFormat('audio/l16;rate=44100');
    expect(f).toMatchObject({ sampleRate: 44100, channels: 2, rateSource: 'mimeType', channelsSource: 'assumed' });
  });
});

describe('pcmDurationSec', () => {
  it('computes seconds from bytes', () => {
    expect(pcmDurationSec(192000, { sampleRate: 48000, channels: 2, bitsPerSample: 16 })).toBe(1);
    expect(pcmDurationSec(88200, { sampleRate: 44100, channels: 1, bitsPerSample: 16 })).toBe(1);
  });
});

describe('byte order helpers', () => {
  const sine = (): Buffer => {
    const frames = 4800;
    const b = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 12000);
      b.writeInt16LE(v, i * 4);
      b.writeInt16LE(v, i * 4 + 2);
    }
    return b;
  };

  it('scores little-endian music as smoother when stored LE', () => {
    const { le, be } = byteOrderScores(sine(), 2);
    expect(le * 4).toBeLessThan(be);
  });

  it('detects big-endian after a byte swap', () => {
    const { le, be } = byteOrderScores(byteswap16(sine()), 2);
    expect(be * 4).toBeLessThan(le);
  });

  it('byteswap16 swaps pairs and leaves the input untouched', () => {
    const src = Buffer.from([1, 2, 3, 4, 5]);
    expect([...byteswap16(src)]).toEqual([2, 1, 4, 3, 5]);
    expect([...src]).toEqual([1, 2, 3, 4, 5]);
  });
});
