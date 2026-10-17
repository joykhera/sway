import { describe, expect, it } from 'vitest';
import { MusicSession } from './session.ts';
import type { SessionDeps } from './session.ts';
import type {
  AudioFormat,
  ServerMessage,
  StreamConfig,
  WeightedPrompt,
} from '../src/shared/protocol.ts';
import type {
  MusicUpstream,
  UpstreamCallbacks,
  UpstreamStartArgs,
} from './upstream/types.ts';

const AUDIO: AudioFormat = {
  format: 'pcm_s16le',
  sampleRateHz: 48000,
  channels: 2,
};
const P = (text: string): WeightedPrompt[] => [{ text, weight: 1 }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeUpstream implements MusicUpstream {
  cb: UpstreamCallbacks | null = null;
  startArgs: UpstreamStartArgs | null = null;
  steers: { prompts: WeightedPrompt[]; config?: StreamConfig }[] = [];
  closed = false;
  gateStart = false;
  failStart: Error | null = null;
  private gate: (() => void) | null = null;

  start(args: UpstreamStartArgs, cb: UpstreamCallbacks) {
    this.startArgs = args;
    this.cb = cb;
    return new Promise<{ audio: AudioFormat }>((resolve, reject) => {
      if (this.failStart) {
        reject(this.failStart);
        return;
      }
      if (this.gateStart) {
        this.gate = () => resolve({ audio: AUDIO });
        return;
      }
      resolve({ audio: AUDIO });
    });
  }
  releaseStart(): void {
    this.gate?.();
  }
  steer(prompts: WeightedPrompt[], config?: StreamConfig): void {
    this.steers.push({ prompts, config });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeSession(overrides: Partial<SessionDeps> = {}) {
  const sent: ServerMessage[] = [];
  const binary: Buffer[] = [];
  const created: FakeUpstream[] = [];
  let disposed = 0;
  const session = new MusicSession({
    send: (m) => sent.push(m),
    sendBinary: (c) => binary.push(c),
    createUpstream: () => {
      const u = new FakeUpstream();
      created.push(u);
      return u;
    },
    onDispose: () => {
      disposed += 1;
    },
    steerIntervalMs: 15,
    reconnectBaseDelayMs: 5,
    ...overrides,
  });
  return {
    session,
    sent,
    binary,
    created,
    disposed: () => disposed,
    start: (prompts = P('pad'), config?: StreamConfig) =>
      session.handleMessage(
        JSON.stringify({ type: 'start', prompts, ...(config ? { config } : {}) }),
      ),
    steer: (revision: number, prompts = P('steer'), config?: StreamConfig) =>
      session.handleMessage(
        JSON.stringify({
          type: 'steer',
          revision,
          prompts,
          ...(config ? { config } : {}),
        }),
      ),
    types: () => sent.map((m) => m.type),
    states: () =>
      sent.filter((m) => m.type === 'status').map((m) => (m as { state: string }).state),
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(2);
  }
}

describe('MusicSession', () => {
  it('start: idle → connecting → ready → playing', async () => {
    const s = makeSession();
    s.start();
    expect(s.sent[0]).toEqual({ type: 'status', state: 'connecting' });
    await until(() => s.session.state === 'playing');
    expect(s.types()).toEqual(['status', 'ready', 'status']);
    expect(s.states()).toEqual(['connecting', 'playing']);
    expect(s.sent[1]).toEqual({ type: 'ready', audio: AUDIO });
    expect(s.created[0]?.startArgs?.prompts).toEqual(P('pad'));
  });

  it('start from non-idle → bad_state', async () => {
    const s = makeSession();
    s.start();
    await until(() => s.session.state === 'playing');
    s.start();
    const err = s.sent.find((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'bad_state', retryable: false });
  });

  it('steer before start → bad_state', () => {
    const s = makeSession();
    s.steer(1);
    expect(s.sent[0]).toMatchObject({ type: 'error', code: 'bad_state' });
  });

  it('malformed message → bad_message', () => {
    const s = makeSession();
    s.session.handleMessage('this is not json');
    s.session.handleMessage(JSON.stringify({ type: 'bogus' }));
    s.session.handleMessage(
      JSON.stringify({ type: 'start', prompts: [{ text: 'x', weight: 0 }] }),
    );
    expect(s.sent.map((m) => (m as { code?: string }).code)).toEqual([
      'bad_message',
      'bad_message',
      'bad_message',
    ]);
    expect(s.session.state).toBe('idle');
  });

  it('upstream start() rejection → upstream_unavailable, back to idle, retry ok', async () => {
    const s = makeSession();
    const failThenOk = () => {
      const u = new FakeUpstream();
      if (s.created.length === 0) u.failStart = new Error('quota exceeded');
      s.created.push(u);
      return u;
    };
    const session = new MusicSession({
      send: (m) => s.sent.push(m),
      sendBinary: (c) => s.binary.push(c),
      createUpstream: failThenOk,
      steerIntervalMs: 15,
      reconnectBaseDelayMs: 5,
    });
    session.handleMessage(JSON.stringify({ type: 'start', prompts: P('x') }));
    await until(() => s.session.state === 'idle' || session.state === 'idle');
    const err = s.sent.find((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'upstream_unavailable', retryable: true });
    // retry works from idle
    session.handleMessage(JSON.stringify({ type: 'start', prompts: P('y') }));
    await until(() => session.state === 'playing');
    expect(s.created[1]?.startArgs?.prompts).toEqual(P('y'));
  });

  it('drops stale steer revisions silently, applies newest only', async () => {
    const s = makeSession();
    s.start();
    await until(() => s.session.state === 'playing');
    s.steer(5, P('five'));
    await until(() => s.created[0]!.steers.length === 1);
    s.steer(5, P('again'));
    s.steer(3, P('three'));
    await sleep(60);
    expect(s.created[0]?.steers).toHaveLength(1);
    expect(s.created[0]?.steers[0]?.prompts).toEqual(P('five'));
    expect(s.sent.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('coalesces a burst of steers: one send, newest wins', async () => {
    const s = makeSession();
    s.start();
    await until(() => s.session.state === 'playing');
    s.steer(1, P('one'));
    s.steer(2, P('two'));
    s.steer(3, P('three'));
    await until(() => s.created[0]!.steers.length === 1, 1000);
    expect(s.created[0]?.steers[0]?.prompts).toEqual(P('three'));
    await sleep(50);
    expect(s.created[0]?.steers).toHaveLength(1);
  });

  it('applies a pending steer sent during connecting after setup', async () => {
    const s = makeSession();
    const gateAll = (): FakeUpstream => {
      const u = new FakeUpstream();
      u.gateStart = true;
      s.created.push(u);
      return u;
    };
    const session = new MusicSession({
      send: (m) => s.sent.push(m),
      sendBinary: (c) => s.binary.push(c),
      createUpstream: gateAll,
      steerIntervalMs: 15,
      reconnectBaseDelayMs: 5,
    });
    session.handleMessage(JSON.stringify({ type: 'start', prompts: P('first') }));
    session.handleMessage(
      JSON.stringify({ type: 'steer', revision: 1, prompts: P('queued') }),
    );
    expect(session.state).toBe('connecting');
    s.created[0]!.releaseStart();
    await until(() => session.state === 'playing');
    await until(() => s.created[0]!.steers.length === 1);
    expect(s.created[0]?.steers[0]?.prompts).toEqual(P('queued'));
  });

  it('upstream drop → reconnecting → fresh ready + playing, latest prompts', async () => {
    const s = makeSession();
    s.start();
    await until(() => s.session.state === 'playing');
    s.steer(7, P('latest'));
    await until(() => s.created[0]!.steers.length === 1);
    s.created[0]!.cb!.onClosed('10 minute cap');
    expect(s.session.state).toBe('reconnecting');
    await until(() => s.session.state === 'playing');
    expect(s.created).toHaveLength(2);
    // restarted with the latest APPLIED prompts (the steer, not the start)
    expect(s.created[1]?.startArgs?.prompts).toEqual(P('latest'));
    // fresh ready re-sent after reconnecting
    expect(s.types()).toEqual([
      'status',
      'ready',
      'status',
      'status',
      'ready',
      'status',
    ]);
    expect(s.states()).toEqual([
      'connecting',
      'playing',
      'reconnecting',
      'playing',
    ]);
  });

  it('reconnect exhaustion → upstream_lost + dispose', async () => {
    const s = makeSession({ maxReconnectAttempts: 3 });
    s.start();
    await until(() => s.session.state === 'playing');
    // every reconnect attempt fails
    let calls = 0;
    const factory = () => {
      calls += 1;
      const u = new FakeUpstream();
      if (calls > 1) u.failStart = new Error('still down');
      s.created.push(u);
      return u;
    };
    const session2 = new MusicSession({
      send: (m) => s.sent.push(m),
      sendBinary: (c) => s.binary.push(c),
      createUpstream: factory,
      steerIntervalMs: 15,
      reconnectBaseDelayMs: 2,
      maxReconnectAttempts: 3,
    });
    const sent2 = s.sent;
    sent2.length = 0;
    session2.handleMessage(JSON.stringify({ type: 'start', prompts: P('x') }));
    await until(() => session2.state === 'playing');
    s.created[s.created.length - 1]!.cb!.onClosed('cap');
    await until(() => session2.state === 'closed', 4000);
    const err = sent2.find((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'upstream_lost', retryable: true });
    expect(calls).toBe(4); // 1 original + 3 reconnect attempts
  });

  it('onAudio → binary frame straight through', async () => {
    const s = makeSession();
    s.start();
    await until(() => s.session.state === 'playing');
    const chunk = Buffer.from([1, 2, 3, 4]);
    s.created[0]!.cb!.onAudio(chunk);
    expect(s.binary).toEqual([chunk]);
  });

  it('filtered prompt → prompt_filtered error (retryable)', async () => {
    const s = makeSession();
    s.start();
    await until(() => s.session.state === 'playing');
    s.created[0]!.cb!.onFiltered?.(['bad words']);
    const err = s.sent.find((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'prompt_filtered', retryable: true });
  });

  it('stop → status stopped, upstream closed, slot released, idempotent', async () => {
    const s = makeSession();
    s.start();
    await until(() => s.session.state === 'playing');
    s.session.handleMessage(JSON.stringify({ type: 'stop' }));
    expect(s.session.state).toBe('closed');
    expect(s.sent[s.sent.length - 1]).toEqual({ type: 'status', state: 'stopped' });
    expect(s.created[0]?.closed).toBe(true);
    expect(s.disposed()).toBe(1);
    s.session.dispose();
    s.session.dispose();
    expect(s.disposed()).toBe(1);
  });

  it('dispose during connecting cancels pending start cleanly', async () => {
    const s = makeSession();
    const session = new MusicSession({
      send: (m) => s.sent.push(m),
      sendBinary: (c) => s.binary.push(c),
      createUpstream: () => {
        const u = new FakeUpstream();
        u.gateStart = true;
        s.created.push(u);
        return u;
      },
      steerIntervalMs: 15,
      reconnectBaseDelayMs: 5,
    });
    session.handleMessage(JSON.stringify({ type: 'start', prompts: P('x') }));
    session.dispose();
    expect(session.state).toBe('closed');
    expect(s.disposed()).toBe(0); // this session had no onDispose → just checking no throw
    expect(s.created[0]?.closed).toBe(true);
    s.created[0]!.releaseStart();
    await sleep(10); // late resolution must not resurrect the session
    expect(session.state).toBe('closed');
    expect(s.types()).not.toContain('ready');
  });
});
