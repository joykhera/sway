import type { Rgb } from './viz/looks.ts';
import type { SessionMoment } from './viz/session-log.ts';

export type MomentsTrayProps = {
  moments: SessionMoment[];
  onRecall: (moment: SessionMoment) => void;
  /** The moment being returned to, if any, for a short caption. */
  recalling: SessionMoment | null;
};

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const css = (c: Rgb) => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;

/** Every 👍 leaves a dot here. Tap one to steer back toward that sound. */
export function MomentsTray({ moments, onRecall, recalling }: MomentsTrayProps) {
  if (moments.length === 0) return null;
  return (
    <div className="moments">
      <div className="moments__dots" role="group" aria-label="moments you liked">
        {moments.map((m) => (
          <button
            key={`${m.t}-${m.label}`}
            type="button"
            className={`moment${recalling === m ? ' moment--active' : ''}`}
            style={{ ['--moment-color' as string]: css(m.color) }}
            data-label={`${m.label || 'this moment'} · ${clock(m.t)}`}
            aria-label={`return to ${m.label || 'this moment'} from ${clock(m.t)}`}
            onClick={() => onRecall(m)}
          />
        ))}
      </div>
      <p className="moments__caption" aria-live="polite">
        {recalling ? `returning to ${recalling.label || 'that moment'}…` : 'moments you liked'}
      </p>
    </div>
  );
}
