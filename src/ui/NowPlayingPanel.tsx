import type { MusicSessionController, MusicSignature, SessionUiState, Vote } from './contracts.ts';
import { describeDecision, hasSignature, sameSignature, signatureLine } from './describe-decision.ts';
import { StatusChip } from './StatusChip.tsx';
import { useStreamLevels } from './use-stream-levels.ts';

const FIELDS = ['genre', 'instrument', 'mood', 'texture'] as const;

/** Re-keyed on value change so the new text softly fades in (CSS `.fade`). */
function Fade({ value }: { value: string }) {
  return (
    <span key={value} className="fade">
      {value}
    </span>
  );
}

function ThumbGlyph({ vote }: { vote: Vote }) {
  return (
    <svg
      className={`now__thumb now__thumb--${vote}`}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5 7h2.3v6.5H2.5zM4.8 7.2 7.6 2.6c.9-.4 1.8.3 1.6 1.3L8.7 6.4h3.9c1 0 1.6.9 1.3 1.8l-1.4 4.4c-.2.6-.7.9-1.3.9H4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "changing…" while the latest vote's steer is still on its way to the speakers. */
function SteerIndicator({ controller }: { controller: MusicSessionController }) {
  const { steerProgress } = useStreamLevels(controller);
  if (steerProgress === null || steerProgress === undefined || steerProgress < 0 || steerProgress >= 1) return null;
  return <p className="now__changing">changing…</p>;
}

function Signature({ signature }: { signature: MusicSignature }) {
  const fields = FIELDS.map((f) => [f, signature[f]?.trim()] as const).filter(
    (entry): entry is readonly [(typeof FIELDS)[number], string] => Boolean(entry[1]),
  );
  const focus = signature.focus?.trim();
  return (
    <>
      {fields.length > 0 ? (
        <dl className="now__fields">
          {fields.map(([name, value]) => (
            <div className="now__field" key={name} data-field={name}>
              <dt className="now__label">{name}</dt>
              <dd className="now__value">
                <Fade value={value} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {focus ? (
        <p className="now__focus">
          <Fade value={`“${focus}”`} />
        </p>
      ) : null}
    </>
  );
}

/**
 * Top-left panel, flowing downward: status (animated note glyph), what is
 * estimated audible now (one field per line + the focus phrase in full), where
 * the steer is heading when that differs, the learner's latest decision in one
 * humble line, and "changing…" while a vote's steer is in flight.
 */
export function NowPlayingPanel({
  state,
  controller,
}: {
  state: SessionUiState;
  controller: MusicSessionController;
}) {
  const audible = hasSignature(state.nowPlaying)
    ? state.nowPlaying
    : hasSignature(state.signature)
      ? state.signature
      : undefined;
  const toward =
    hasSignature(state.nowPlaying) &&
      hasSignature(state.signature) &&
      !sameSignature(state.nowPlaying, state.signature)
      ? signatureLine(state.signature)
      : null;
  const decision = state.decision;

  return (
    <section className="now" aria-label="now playing">
      <StatusChip status={state.status} lastError={state.lastError} />
      {audible ? (
        <div className="now__block">
          <h2 className="now__heading">now playing</h2>
          <Signature signature={audible} />
        </div>
      ) : null}
      {toward ? (
        <div className="now__block now__block--toward">
          <h2 className="now__heading">heading toward</h2>
          <p className="now__toward">
            <Fade value={toward} />
          </p>
        </div>
      ) : null}
      {decision ? (
        <p className="now__decision" key={decision.at}>
          <ThumbGlyph vote={decision.vote} />
          <span className="sr-only">{decision.vote === 'up' ? 'after your like: ' : 'after your dislike: '}</span>
          <span className="now__decision-text">{describeDecision(decision)}</span>
        </p>
      ) : null}
      <SteerIndicator controller={controller} />
    </section>
  );
}
