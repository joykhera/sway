import { useEffect, useRef } from 'react';
import { drawPortrait } from './viz/portrait.ts';
import type { Rgb } from './viz/looks.ts';
import type { SessionLog } from './viz/session-log.ts';

export type SessionPortraitProps = {
  log: SessionLog;
  onClose: () => void;
};

function token(name: string, fallback: Rgb): Rgb {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : fallback;
}

/** jsdom exposes <canvas> but no 2d context; skip drawing there. */
const canDraw = () => typeof navigator === 'undefined' || !/jsdom/i.test(navigator.userAgent);

/** Shown after End Session: the portrait of what you just listened to, to keep. */
export function SessionPortrait({ log, onClose }: SessionPortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canDraw()) return;
    void drawPortrait(canvas, log, {
      ink: token('--fg', [0.93, 0.9, 0.85]),
      muted: token('--muted', [0.55, 0.52, 0.47]),
      warm: token('--accent', [0.94, 0.66, 0.38]),
      cool: token('--accent-cool', [0.49, 0.78, 0.89]),
    });
  }, [log]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sway-${new Date(log.startedAt).toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  };

  return (
    <div className="portrait" role="dialog" aria-modal="true" aria-label="your session portrait">
      <canvas ref={canvasRef} className="portrait__image" />
      <div className="portrait__actions">
        <button type="button" onClick={save}>save image</button>
        <button type="button" ref={closeRef} onClick={onClose}>close</button>
      </div>
    </div>
  );
}
