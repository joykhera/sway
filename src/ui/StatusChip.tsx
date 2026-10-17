import type { KnownStatus } from './contracts.ts';

export type StatusChipProps = {
  status: string;
  lastError?: string;
};

const LABELS: Record<KnownStatus, string> = {
  idle: 'ready',
  connecting: 'connecting…',
  playing: 'playing',
  reconnecting: 'reconnecting…',
  unavailable: 'temporarily unavailable',
  stopped: 'stopped',
  error: 'something went wrong',
};

/**
 * Two beamed eighth notes, drawn in currentColor. CSS gives each status its own
 * motion: a gentle sway while playing, a soft breath while connecting, a
 * hesitant flicker while reconnecting, a still tilt on error.
 */
function NoteGlyph() {
  return (
    <svg
      className="status-chip__note"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5.6 12.2V4.3L13.6 2.4v8.1" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M5.6 4.3 13.6 2.4v1.9L5.6 6.2Z" fill="currentColor" />
      <ellipse cx="3.9" cy="12.4" rx="1.9" ry="1.45" transform="rotate(-20 3.9 12.4)" fill="currentColor" />
      <ellipse cx="11.9" cy="10.6" rx="1.9" ry="1.45" transform="rotate(-20 11.9 10.6)" fill="currentColor" />
    </svg>
  );
}

/** Session status line (top-left panel). Unknown status strings render verbatim. */
export function StatusChip({ status, lastError }: StatusChipProps) {
  const known = Object.prototype.hasOwnProperty.call(LABELS, status);
  const label = known ? LABELS[status as KnownStatus] : status;
  return (
    <div
      className={`status-chip${known ? ` status-chip--${status}` : ''}`}
      role="status"
      aria-live="polite"
    >
      <NoteGlyph />
      <span className="status-chip__body">
        <span className="status-chip__label">{label}</span>
        {lastError ? <span className="status-chip__error">{lastError}</span> : null}
      </span>
    </div>
  );
}
