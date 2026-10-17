// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThumbsControls } from './ThumbsControls.tsx';

afterEach(cleanup);

const UP = "like what you're hearing";
const DOWN = 'hear something different';
const noop = () => {};

function renderThumbs(props: Partial<Parameters<typeof ThumbsControls>[0]> = {}) {
  return render(<ThumbsControls onVote={noop} lastVote={null} {...props} />);
}

describe('ThumbsControls', () => {
  it('renders both buttons with their aria labels', () => {
    renderThumbs();
    expect(screen.getByLabelText(UP)).toBeTruthy();
    expect(screen.getByLabelText(DOWN)).toBeTruthy();
  });

  it('buttons are never disabled', () => {
    renderThumbs();
    for (const label of [UP, DOWN]) {
      const btn = screen.getByLabelText(label) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.type).toBe('button');
    }
  });

  it('fires onVote("up") and onVote("down") synchronously', () => {
    const onVote = vi.fn();
    renderThumbs({ onVote });
    fireEvent.click(screen.getByLabelText(UP));
    expect(onVote).toHaveBeenCalledTimes(1);
    expect(onVote).toHaveBeenLastCalledWith('up');
    fireEvent.click(screen.getByLabelText(DOWN));
    expect(onVote).toHaveBeenCalledTimes(2);
    expect(onVote).toHaveBeenLastCalledWith('down');
  });

  it('applies the voted class on the matching side only', () => {
    const { rerender } = renderThumbs();
    const up = screen.getByLabelText(UP);
    const down = screen.getByLabelText(DOWN);
    expect(up.className).not.toContain('thumb--voted');
    expect(down.className).not.toContain('thumb--voted');

    rerender(<ThumbsControls onVote={noop} lastVote={{ v: 'down', at: 123 }} />);
    expect(down.className).toContain('thumb--voted');
    expect(up.className).not.toContain('thumb--voted');

    rerender(<ThumbsControls onVote={noop} lastVote={{ v: 'up', at: 124 }} />);
    expect(up.className).toContain('thumb--voted');
    expect(down.className).not.toContain('thumb--voted');

    rerender(<ThumbsControls onVote={noop} lastVote={null} />);
    expect(up.className).not.toContain('thumb--voted');
    expect(down.className).not.toContain('thumb--voted');
  });
});
