import type { Vote } from './contracts.ts';

export type ThumbsControlsProps = {
  onVote: (v: Vote) => void;
  lastVote: { v: Vote; at: number } | null;
};

function ThumbGlyph({ down = false }: { down?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={down ? 'rotate(180 12 12)' : undefined}>
        <path d="M7 10v12" />
        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
      </g>
    </svg>
  );
}

/**
 * The only two steering controls: like it / change it. Buttons are never disabled —
 * voting is a synchronous local signal and the controller ignores votes it can't use.
 * `lastVote` fires a brief radial pulse through the matching lens.
 */
export function ThumbsControls({ onVote, lastVote }: ThumbsControlsProps) {
  return (
    <div className="thumbs" role="group" aria-label="steer the stream">
      <button
        type="button"
        className={`thumb thumb--up${lastVote?.v === 'up' ? ' thumb--voted' : ''}`}
        aria-label="like what you're hearing"
        onClick={() => onVote('up')}
      >
        <ThumbGlyph />
      </button>
      <button
        type="button"
        className={`thumb thumb--down${lastVote?.v === 'down' ? ' thumb--voted' : ''}`}
        aria-label="hear something different"
        onClick={() => onVote('down')}
      >
        <ThumbGlyph down />
      </button>
    </div>
  );
}
