// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowVisualizer, Visualizer } from './Visualizer.tsx';

afterEach(cleanup);

// jsdom exposes <canvas> but no 2d or WebGL2 context, so these tests exercise
// exactly the degradation paths: the ring renders its element without drawing,
// and the flow piece reports itself unavailable via onUnavailable.

describe('Visualizer (2D ring fallback)', () => {
  it('renders a hidden-from-AT canvas', () => {
    const { container } = render(<Visualizer active={true} lastVote={null} />);
    const canvas = container.querySelector('canvas.visualizer');
    expect(canvas).toBeTruthy();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
  });

  it('absorbs active and vote prop changes without a 2D context', () => {
    const { container, rerender } = render(<Visualizer active={false} lastVote={null} />);
    rerender(<Visualizer active={true} lastVote={{ v: 'up', at: Date.now() }} />);
    rerender(<Visualizer active={true} lastVote={{ v: 'down', at: Date.now() + 1 }} />);
    rerender(<Visualizer active={false} lastVote={null} />);
    expect(container.querySelector('canvas.visualizer')).toBeTruthy();
  });

  it('unmounts cleanly', () => {
    const { unmount } = render(<Visualizer active={true} lastVote={null} />);
    unmount();
  });
});

describe('FlowVisualizer (the smoke)', () => {
  it('renders the full-bleed flow canvas', () => {
    const { container } = render(<FlowVisualizer active={true} lastVote={null} />);
    const canvas = container.querySelector('canvas.visualizer--flow');
    expect(canvas).toBeTruthy();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reports itself unavailable where WebGL2 is missing (jsdom)', () => {
    const onUnavailable = vi.fn();
    render(<FlowVisualizer active={true} lastVote={null} onUnavailable={onUnavailable} />);
    expect(onUnavailable).toHaveBeenCalled();
  });

  it('degrades silently without an onUnavailable handler', () => {
    const { container, unmount } = render(<FlowVisualizer active={false} lastVote={null} />);
    expect(container.querySelector('canvas.visualizer--flow')).toBeTruthy();
    unmount();
  });
});
