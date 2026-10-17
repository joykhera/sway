// A light record of one listening session (Start → End), for its portrait.
import type { MomentTarget, Vote } from '../contracts.ts';
import type { Rgb } from './looks.ts';

export type SessionSample = {
  /** Seconds since the session started. */
  t: number;
  colorA: Rgb;
  colorB: Rgb;
  /** 0..1 loudness of the moment. */
  energy: number;
  label: string;
};

export type SessionMoment = { t: number; label: string; color: Rgb; target: MomentTarget };

export type SessionLog = {
  startedAt: number;
  /** Seconds listened. */
  duration: number;
  samples: SessionSample[];
  votes: { t: number; v: Vote }[];
  moments: SessionMoment[];
  /** Learned taste at the end of the session, raw learner scores. */
  taste: Record<string, number>;
};

/** One sample a second covers ~2 h before the cap thins it. */
const MAX_SAMPLES = 7200;
/** Moments kept for recall; the portrait still shows every like. */
export const MAX_MOMENTS = 8;

export class SessionRecorder {
  private log: SessionLog | null = null;
  private allMoments: SessionMoment[] = [];

  start(nowMs: number): void {
    this.log = { startedAt: nowMs, duration: 0, samples: [], votes: [], moments: [], taste: {} };
    this.allMoments = [];
  }

  get active(): boolean {
    return this.log !== null;
  }

  private t(nowMs: number): number {
    return this.log ? Math.max(0, (nowMs - this.log.startedAt) / 1000) : 0;
  }

  sample(nowMs: number, sample: Omit<SessionSample, 't'>): void {
    if (!this.log) return;
    const samples = this.log.samples;
    samples.push({ ...sample, t: this.t(nowMs) });
    // Thin evenly rather than drop the start of a long session.
    if (samples.length > MAX_SAMPLES) this.log.samples = samples.filter((_, i) => i % 2 === 0);
    this.log.duration = this.t(nowMs);
  }

  vote(nowMs: number, v: Vote): void {
    this.log?.votes.push({ t: this.t(nowMs), v });
  }

  /** Records a liked moment; returns the recall list (newest last, capped). */
  moment(nowMs: number, moment: Omit<SessionMoment, 't'>): SessionMoment[] {
    if (!this.log) return [];
    const entry = { ...moment, t: this.t(nowMs) };
    this.allMoments.push(entry);
    const last = this.log.moments.at(-1);
    // Repeated likes of the same sound keep one entry, refreshed.
    const kept = last && last.label === entry.label ? this.log.moments.slice(0, -1) : this.log.moments;
    this.log.moments = [...kept, entry].slice(-MAX_MOMENTS);
    return this.log.moments;
  }

  /** Ends the session; null when it was too short to be worth a portrait. */
  finish(nowMs: number, taste: Record<string, number>, minSeconds = 20): SessionLog | null {
    const log = this.log;
    if (!log) return null;
    log.duration = this.t(nowMs);
    log.taste = taste;
    this.log = null;
    return log.duration >= minSeconds && log.samples.length > 0 ? { ...log, moments: this.allMoments } : null;
  }
}
