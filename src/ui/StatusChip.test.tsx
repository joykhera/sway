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
    ['error', 'something went wrong'],
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

  it('error gets the status-chip--error modifier and shows lastError below the label', () => {
    const { container } = render(
      <StatusChip status="error" lastError="Could not reconnect to the music service" />,
    );
    const chip = container.querySelector('.status-chip');
    expect(chip?.className).toContain('status-chip--error');
    expect(screen.getByText('something went wrong')).toBeTruthy();
    expect(screen.getByText('Could not reconnect to the music service')).toBeTruthy();
  });

  it('renders a long lastError in full (truncation is CSS-only ellipsis)', () => {
    const long =
      'Audio could not start: Lyria quota exhausted after several reconnect attempts';
    render(<StatusChip status="error" lastError={long} />);
    const error = screen.getByText(long);
    expect(error.className).toContain('status-chip__error');
  });

  it('omits the error line when lastError is absent', () => {
    const { container } = render(<StatusChip status="playing" />);
    expect(container.querySelector('.status-chip__error')).toBeNull();
  });
});
