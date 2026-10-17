import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WAV_HEADER_BYTES, WavFileWriter, wavHeader } from '../../scripts/smoke/wav.ts';

const STEREO_48K = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

function readHeader(b: Buffer) {
  return {
    riff: b.toString('ascii', 0, 4),
    riffSize: b.readUInt32LE(4),
    wave: b.toString('ascii', 8, 12),
    fmt: b.toString('ascii', 12, 16),
    fmtSize: b.readUInt32LE(16),
    audioFormat: b.readUInt16LE(20),
    channels: b.readUInt16LE(22),
    sampleRate: b.readUInt32LE(24),
    byteRate: b.readUInt32LE(28),
    blockAlign: b.readUInt16LE(32),
    bitsPerSample: b.readUInt16LE(34),
    data: b.toString('ascii', 36, 40),
    dataSize: b.readUInt32LE(40),
  };
}

describe('wavHeader', () => {
  it('writes a canonical 48 kHz stereo s16 header', () => {
    const h = wavHeader(1000, STEREO_48K);
    expect(h.length).toBe(44);
    expect(readHeader(h)).toEqual({
      riff: 'RIFF',
      riffSize: 1036,
      wave: 'WAVE',
      fmt: 'fmt ',
      fmtSize: 16,
      audioFormat: 1,
      channels: 2,
      sampleRate: 48000,
      byteRate: 192000,
      blockAlign: 4,
      bitsPerSample: 16,
      data: 'data',
      dataSize: 1000,
    });
  });

  it('derives byte rate and block align for 44.1 kHz mono', () => {
    const h = readHeader(wavHeader(0, { sampleRate: 44100, channels: 1, bitsPerSample: 16 }));
    expect(h).toMatchObject({ sampleRate: 44100, channels: 1, byteRate: 88200, blockAlign: 2, riffSize: 36, dataSize: 0 });
  });
});

describe('WavFileWriter', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('appends frame-aligned data and finalizes sizes', () => {
    dir = mkdtempSync(join(tmpdir(), 'wav-test-'));
    const path = join(dir, 'out.wav');
    const w = new WavFileWriter(path, STEREO_48K);
    w.append(Buffer.from([1, 2, 3, 4, 5, 6])); // 1.5 frames → 1 frame written, 2 bytes carried
    w.append(Buffer.from([7, 8])); // completes the 2nd frame
    expect(w.bytesWritten).toBe(8);
    w.finalize();
    w.finalize(); // idempotent

    const file = readFileSync(path);
    expect(file.length).toBe(WAV_HEADER_BYTES + 8);
    const h = readHeader(file);
    expect(h.dataSize).toBe(8);
    expect(h.riffSize).toBe(36 + 8);
    expect([...file.subarray(WAV_HEADER_BYTES)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('flushHeader keeps the file valid mid-stream', () => {
    dir = mkdtempSync(join(tmpdir(), 'wav-test-'));
    const path = join(dir, 'out.wav');
    const w = new WavFileWriter(path, STEREO_48K);
    w.append(Buffer.alloc(400));
    w.flushHeader();
    expect(readHeader(readFileSync(path)).dataSize).toBe(400);
    w.finalize();
  });
});
