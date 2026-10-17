// @vitest-environment jsdom
// App wiring tests. The ui/audio barrels are replaced wholesale at the module
// boundary, so these tests verify composition only — never real audio internals.
// main.tsx mounts App under StrictMode; every mount below does the same.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App.tsx';

// Allow React's act() outside a test-library harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Hoisted mock state ───────────────────────────────────────────────────────

interface ControllerOptions {
  playerFactory: () => unknown;
  generatorFactory: () => unknown;
}

interface FakeController {
  options: ControllerOptions;
  start: ReturnType<typeof vi.fn>;
  vote: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  fakePlayer: { kind: 'fake-PCMPlayer' },
  calls: { createPCMPlayer: 0, constructPcmGenerator: 0 },
  /** Every `controller` prop the stub PlayerScreen rendered, in order. */
  renderedControllers: [] as unknown[],
  /** Every mock-controller construction, in order. */
  controllerInstances: [] as FakeController[],
}));

vi.mock('./ui/index.ts', () => {
  class MockMusicSessionController implements FakeController {
    readonly options: ControllerOptions;
    readonly start = vi.fn(() => Promise.resolve());
    readonly vote = vi.fn((_v: unknown) => { });
    readonly stop = vi.fn(() => { });
    readonly subscribe = vi.fn((_listener: unknown) => () => { });
    constructor(options: ControllerOptions) {
      this.options = options;
      h.controllerInstances.push(this);
    }
  }

  function PlayerScreen(props: { controller: unknown }) {
    h.renderedControllers.push(props.controller);
    return <div data-testid="player-screen" />;
  }

  return { PlayerScreen, MockMusicSessionController };
});

vi.mock('./audio/index.ts', () => ({
  createPCMPlayer: vi.fn(() => {
    h.calls.createPCMPlayer += 1;
    return h.fakePlayer;
  }),
  MockPcmGenerator: vi.fn(function MockPcmGenerator() {
    h.calls.constructPcmGenerator += 1;
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

async function mount(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
  return { root, container };
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

beforeEach(() => {
  // App only builds the standalone MockMusicSessionController under `?mock`.
  window.history.pushState({}, '', '/?mock');
  h.calls.createPCMPlayer = 0;
  h.calls.constructPcmGenerator = 0;
  h.renderedControllers.length = 0;
  h.controllerInstances.length = 0;
  document.body.replaceChildren();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('App', () => {
  it('renders PlayerScreen and passes a MockMusicSessionController instance as controller', async () => {
    const { root, container } = await mount();
    try {
      expect(container.querySelectorAll('[data-testid="player-screen"]')).toHaveLength(1);
      // StrictMode double-invokes render in dev; the ref still yields exactly one controller.
      expect(h.controllerInstances).toHaveLength(1);
      const controller = h.controllerInstances[0]!;
      expect(h.renderedControllers.length).toBeGreaterThanOrEqual(1);
      expect(h.renderedControllers.every((c) => c === controller)).toBe(true);
    } finally {
      await unmount(root, container);
    }
  });

  it('supplies playerFactory and generatorFactory to the controller constructor', async () => {
    const { root, container } = await mount();
    try {
      const controller = h.controllerInstances[0]!;
      const { playerFactory, generatorFactory } = controller.options;
      expect(typeof playerFactory).toBe('function');
      expect(typeof generatorFactory).toBe('function');

      expect(playerFactory()).toBe(h.fakePlayer);
      expect(h.calls.createPCMPlayer).toBe(1);

      const generator = generatorFactory();
      expect(generator).toBeTruthy();
      expect(h.calls.constructPcmGenerator).toBe(1);
    } finally {
      await unmount(root, container);
    }
  });

  it('calls controller.stop() on unmount', async () => {
    const { root, container } = await mount();
    const controller = h.controllerInstances[0]!;
    // StrictMode replays mount effects in dev, so stop() may already have run once.
    const callsBefore = controller.stop.mock.calls.length;
    await unmount(root, container);
    expect(controller.stop.mock.calls.length).toBe(callsBefore + 1);
  });

  it('keeps exactly one controller per mounted App across StrictMode replays', async () => {
    const first = await mount();
    const firstRenderCount = h.renderedControllers.length;
    const second = await mount();
    try {
      // Two roots → two PlayerScreens → but still only one controller per App.
      expect(first.container.querySelectorAll('[data-testid="player-screen"]')).toHaveLength(1);
      expect(second.container.querySelectorAll('[data-testid="player-screen"]')).toHaveLength(1);
      expect(h.controllerInstances).toHaveLength(2);
      const c1 = h.controllerInstances[0]!;
      const c2 = h.controllerInstances[1]!;
      expect(c1).not.toBe(c2);

      // The same controller object persisted for that mount across every render.
      expect(h.renderedControllers.slice(0, firstRenderCount).every((c) => c === c1)).toBe(true);
      expect(h.renderedControllers.slice(firstRenderCount).every((c) => c === c2)).toBe(true);

      const c1Stops = c1.stop.mock.calls.length;
      const c2Stops = c2.stop.mock.calls.length;
      await unmount(first.root, first.container);
      expect(c1.stop.mock.calls.length).toBe(c1Stops + 1);
      expect(c2.stop.mock.calls.length).toBe(c2Stops);
      await unmount(second.root, second.container);
      expect(c2.stop.mock.calls.length).toBe(c2Stops + 1);
    } finally {
      first.container.remove();
      second.container.remove();
    }
  });
});
