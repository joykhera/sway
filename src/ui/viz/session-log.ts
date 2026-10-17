// The moments liked in one listening session (Start → End), to return to.
import type { MomentTarget } from '../contracts.ts';
import type { Rgb } from './looks.ts';

export type SessionMoment = { t: number; label: string; color: Rgb; target: MomentTarget };

/** Moments kept for recall. */
export const MAX_MOMENTS = 8;

export class SessionRecorder {
  private startedAt: number | null = null;
  private moments: SessionMoment[] = [];

  start(nowMs: number): void {
    this.startedAt = nowMs;
    this.moments = [];
  }

  get active(): boolean {
    return this.startedAt !== null;
  }

  /** Records a liked moment; returns the recall list (newest last, capped). */
  moment(nowMs: number, moment: Omit<SessionMoment, 't'>): SessionMoment[] {
    if (this.startedAt === null) return [];
    const entry = { ...moment, t: Math.max(0, (nowMs - this.startedAt) / 1000) };
    const last = this.moments.at(-1);
    // Repeated likes of the same sound keep one entry, refreshed.
    const kept = last && last.label === entry.label ? this.moments.slice(0, -1) : this.moments;
    this.moments = [...kept, entry].slice(-MAX_MOMENTS);
    return this.moments;
  }

  finish(): void {
    this.startedAt = null;
    this.moments = [];
  }
}
