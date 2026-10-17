// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasteVerse } from './TasteVerse.tsx';
import { createTasteField } from './viz/verse.ts';

afterEach(cleanup);

describe('TasteVerse', () => {
  it('renders a decorative canvas and stays quiet without a 2d context (jsdom)', () => {
    const source = { getTaste: vi.fn(() => ({ jazz: 1 })), getAudibleFeatures: vi.fn(() => ({ jazz: 0.5 })) };
    const field = createTasteField();
    const { container, rerender } = render(<TasteVerse source={source} ringFraction={0.42} lastVote={null} field={field} />);
    const canvas = container.querySelector('canvas.taste-verse');
    expect(canvas).not.toBeNull();
    expect(canvas!.getAttribute('aria-hidden')).toBe('true');
    rerender(<TasteVerse source={source} ringFraction={0.42} lastVote={{ v: 'up', at: Date.now() }} field={field} />);
    // No drawing loop in jsdom, so the shared field is left alone.
    expect(field.words).toEqual([]);
  });
});
