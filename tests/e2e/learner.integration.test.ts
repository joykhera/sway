// Checkpoint 2: C's real seeded learner driven through D's controller with simulated votes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionController } from '../../src/controller/index.ts';
import * as learner from '../../src/learner/index.ts';
import { WEIGHT_MAX, WEIGHT_MIN, type Learner, type SessionState } from '../../src/shared/protocol.ts';
import { FakePlayer, fakeRelay } from './harness.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function run(seed: number, votes: ('up' | 'down')[]) {
  const relay = fakeRelay();
  const player = new FakePlayer();
  const states: SessionState[] = [];
  const c = new SessionController({ learner: learner as Learner, player, createTransport: relay.create, seed });
  c.subscribe((s) => states.push(s));
  await c.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const [i, v] of votes.entries()) {
    c.vote(v);
    await vi.advanceTimersByTimeAsync(i % 3 === 0 ? 500 : 9000); // a mix of mid-ramp and settled votes
  }
  await vi.advanceTimersByTimeAsync(10_000);
  c.stop();
  return relay.transports[0]!;
}

const pattern = Array.from({ length: 200 }, (_, i) => (i % 5 === 4 || i % 7 === 0 ? 'up' : 'down') as 'up' | 'down');

describe('real learner through the controller', () => {
  it('only ever sends valid prompt sets with increasing revisions that the relay accepts', async () => {
    const t = await run(42, pattern);
    expect(t.steers.length).toBeGreaterThan(pattern.length);
    for (const m of [t.sent[0]!, ...t.steers]) {
      const prompts = (m as { prompts: { text: string; weight: number }[] }).prompts;
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) {
        expect(p.text.length).toBeGreaterThan(0);
        expect(Number.isFinite(p.weight)).toBe(true);
        expect(p.weight).toBeGreaterThanOrEqual(WEIGHT_MIN);
        expect(p.weight).toBeLessThanOrEqual(WEIGHT_MAX);
      }
    }
    const revs = t.steers.map((s) => s.revision);
    expect(revs.every((r, i) => i === 0 || r > revs[i - 1]!)).toBe(true);
    expect(t.accepted).toEqual(revs);
  });

  it('is reproducible for a given seed and differs across seeds', async () => {
    const a = await run(7, pattern.slice(0, 30));
    const b = await run(7, pattern.slice(0, 30));
    const c = await run(8, pattern.slice(0, 30));
    expect(JSON.stringify(a.sent)).toBe(JSON.stringify(b.sent));
    expect(JSON.stringify(a.sent)).not.toBe(JSON.stringify(c.sent));
  });

  it('a downvote produces a different final prompt set', async () => {
    const t = await run(3, ['down']);
    const first = (t.sent[0] as { prompts: unknown }).prompts;
    expect(JSON.stringify(t.steers.at(-1)!.prompts)).not.toBe(JSON.stringify(first));
  });

  it('silence drifts the music without a vote', async () => {
    const relay = fakeRelay();
    const c = new SessionController({ learner: learner as Learner, player: new FakePlayer(), createTransport: relay.create, seed: 5 });
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    const t = relay.transports[0]!;
    expect(t.steers.length).toBeGreaterThan(0);
    c.stop();
  });
});
