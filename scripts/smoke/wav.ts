import { closeSync, openSync, writeSync } from 'node:fs';
import type { PcmFormat } from './audio-format.ts';

export const WAV_HEADER_BYTES = 44;

/** Canonical 44-byte PCM WAV (RIFF) header. */
export function wavHeader(dataBytes: number, fmt: Readonly<PcmFormat>): Buffer {
  const blockAlign = fmt.channels * (fmt.bitsPerSample / 8);
  const byteRate = fmt.sampleRate * blockAlign;
  const b = Buffer.alloc(WAV_HEADER_BYTES);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(fmt.channels, 22);
  b.writeUInt32LE(fmt.sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(fmt.bitsPerSample, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/**
 * Incremental WAV writer using synchronous fs calls so it can be finalized
 * from a signal handler. Partial frames are carried over between appends so
 * the data chunk is always frame-aligned.
 */
export class WavFileWriter {
  readonly path: string;
  readonly format: Readonly<PcmFormat>;
  private fd: number | undefined;
  private dataBytes = 0;
  private carry: Buffer = Buffer.alloc(0);
  private readonly blockAlign: number;

  constructor(path: string, format: Readonly<PcmFormat>) {
    this.path = path;
    this.format = format;
    this.blockAlign = format.channels * (format.bitsPerSample / 8);
    this.fd = openSync(path, 'w');
    writeSync(this.fd, wavHeader(0, format), 0, WAV_HEADER_BYTES, 0);
  }

  get bytesWritten(): number {
    return this.dataBytes;
  }

  append(pcm: Uint8Array): void {
    if (this.fd === undefined) return;
    const buf = this.carry.length > 0 ? Buffer.concat([this.carry, pcm]) : Buffer.from(pcm);
    const usable = buf.length - (buf.length % this.blockAlign);
    if (usable > 0) {
      writeSync(this.fd, buf, 0, usable, WAV_HEADER_BYTES + this.dataBytes);
      this.dataBytes += usable;
    }
    this.carry = buf.subarray(usable);
  }

  /** Rewrite the header with the current size (keeps the file playable mid-run). */
  flushHeader(): void {
    if (this.fd === undefined) return;
    writeSync(this.fd, wavHeader(this.dataBytes, this.format), 0, WAV_HEADER_BYTES, 0);
  }

  /** Patch the header and close. Safe to call more than once. */
  finalize(): void {
    if (this.fd === undefined) return;
    this.flushHeader();
    closeSync(this.fd);
    this.fd = undefined;
  }
}
