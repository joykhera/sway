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

/** Small top-left session indicator. Unknown status strings render verbatim. */
export function StatusChip({ status, lastError }: StatusChipProps) {
  const known = Object.prototype.hasOwnProperty.call(LABELS, status);
  const label = known ? LABELS[status as KnownStatus] : status;
  return (
    <div
      className={`status-chip${known ? ` status-chip--${status}` : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="status-chip__dot" aria-hidden="true" />
      <span className="status-chip__body">
        <span className="status-chip__label">{label}</span>
        {lastError ? <span className="status-chip__error">{lastError}</span> : null}
      </span>
    </div>
  );
}
