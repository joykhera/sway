// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusChip } from './StatusChip.tsx';

afterEach(cleanup);

describe('StatusChip', () => {
  it.each([
    ['idle', 'ready'],
    ['connecting', 'connecting…'],
    ['playing', 'playing'],
    ['reconnecting', 'reconnecting…'],
    ['unavailable', 'temporarily unavailable'],
    ['stopped', 'stopped'],
  ] as const)('maps status %s → %s', (status, label) => {
    render(<StatusChip status={status} />);
    const chip = screen.getByRole('status');
    expect(chip.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('renders unknown status strings verbatim', () => {
    render(<StatusChip status="buffering_hard" />);
    expect(screen.getByText('buffering_hard')).toBeTruthy();
  });

  it('renders lastError on a second line when present', () => {
    const { container } = render(<StatusChip status="unavailable" lastError="relay offline" />);
    const error = screen.getByText('relay offline');
    expect(error.className).toContain('status-chip__error');
    // still shows the mapped label above it
    expect(screen.getByText('temporarily unavailable')).toBeTruthy();
    expect(container.querySelectorAll('.status-chip__error')).toHaveLength(1);
  });

  it('omits the error line when lastError is absent', () => {
    const { container } = render(<StatusChip status="playing" />);
    expect(container.querySelector('.status-chip__error')).toBeNull();
  });
});
