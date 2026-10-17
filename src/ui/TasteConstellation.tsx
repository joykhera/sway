import { useEffect, useRef } from 'react';
import type { MusicSessionController } from './contracts.ts';
import { FEATURE_GROUPS, GROUP_IDS, normalizeTaste } from './viz/describe.ts';

export type TasteConstellationProps = {
  source: Pick<MusicSessionController, 'getTaste' | 'getAudibleFeatures'>;
  /** Ring radius as a fraction of half the viewport height, so threads end at the ring. */
  ringFraction: number;
};

/** Re-read taste and the audible blend this often; drawing eases between reads. */
const POLL_MS = 300;
/** A score change this large (normalized) since the last read flashes the star. */
const FLASH_DELTA = 0.04;
const FLASH_S = 1.4;
/** Leave the bottom of the circle free for the thumbs. */
const GAP_RADIANS = (70 * Math.PI) / 180;

type Star = { id: string; angle: number; taste: number; audible: number; flashAt: number; flashSign: number };

/** jsdom exposes <canvas> but no 2d context (calling it logs a "not implemented" error). */
function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return null;
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/** Groups in order around the circle, with a one-and-a-half-slot gap between groups. */
function layout(): Star[] {
  const slots: { id: string; slot: number }[] = [];
  let slot = 0;
  GROUP_IDS.forEach((group, g) => {
    if (g > 0) slot += 1.5;
    for (const id of FEATURE_GROUPS[group]) slots.push({ id, slot: slot++ });
  });
  const span = Math.PI * 2 - GAP_RADIANS;
  const last = slots.at(-1)!.slot;
  // Canvas angles run clockwise from +x; π/2 is straight down.
  const start = Math.PI / 2 + GAP_RADIANS / 2;
  return slots.map(({ id, slot: s }) => ({ id, angle: start + (s / last) * span, taste: 0, audible: 0, flashAt: -Infinity, flashSign: 0 }));
}

/**
 * The learner's picture of your taste, drawn as 18 stars around the ring.
 * Liked features burn warm and bright, disliked ones go cool and hollow, the
 * ones you're hearing now send a thread into the ring, and every vote that
 * moves a score makes that star flash. It's the learning made visible.
 */
export function TasteConstellation({ source, ringFraction }: TasteConstellationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = get2dContext(canvas);
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--fg').trim() || '#ece5d8';
    const warm = css.getPropertyValue('--accent').trim() || '#f0a860';
    const cool = css.getPropertyValue('--accent-cool').trim() || '#7ec8e3';
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const stars = layout();
    const shown = new Map(stars.map((s) => [s.id, { taste: 0, audible: 0 }]));
    let primed = false;
    let lastPoll = -Infinity;
    let dpr = 1;
    let raf = 0;
    let lastFrame = 0;

    const poll = (now: number) => {
      const src = sourceRef.current;
      const taste = normalizeTaste(src.getTaste?.() ?? {});
      const audible = src.getAudibleFeatures?.() ?? {};
      const total = Object.values(audible).reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
      for (const star of stars) {
        const next = taste[star.id] ?? 0;
        // No flash for the first read: the stars start where the learner already is.
        if (primed && Math.abs(next - star.taste) > FLASH_DELTA) {
          star.flashAt = now;
          star.flashSign = Math.sign(next - star.taste);
        }
        star.taste = next;
        star.audible = total > 0 ? Math.max(0, audible[star.id] ?? 0) / total : 0;
      }
      primed = true;
    };

    const draw = (nowMs: number) => {
      const now = nowMs / 1000;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(h * 0.4, w * 0.42);
      const ringR = (h / 2) * ringFraction * 1.08;
      const k = 1 - Math.exp(-1 / 12); // ease displayed values toward the latest read

      ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      for (const star of stars) {
        const s = shown.get(star.id)!;
        s.taste += (star.taste - s.taste) * k;
        s.audible += (star.audible - s.audible) * k;
        const x = cx + Math.cos(star.angle) * radius;
        const y = cy + Math.sin(star.angle) * radius;
        const like = Math.max(0, s.taste);
        const dislike = Math.max(0, -s.taste);

        // A thread from star to ring while this feature is audible, with light travelling inward.
        if (s.audible > 0.02) {
          const ex = cx + Math.cos(star.angle) * ringR;
          const ey = cy + Math.sin(star.angle) * ringR;
          const alpha = Math.min(0.55, s.audible * 1.6);
          const line = ctx.createLinearGradient(x, y, ex, ey);
          line.addColorStop(0, ink);
          line.addColorStop(1, 'transparent');
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = line;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          if (!reduced) {
            const p = (now * 0.5 + star.angle) % 1;
            ctx.globalAlpha = alpha * (1 - p);
            ctx.fillStyle = ink;
            ctx.beginPath();
            ctx.arc(x + (ex - x) * p, y + (ey - y) * p, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Liked: a warm glow and a four-point glint that grow with the score.
        if (like > 0.02) {
          const glow = ctx.createRadialGradient(x, y, 0, x, y, 6 + 22 * like);
          glow.addColorStop(0, warm);
          glow.addColorStop(1, 'transparent');
          ctx.globalAlpha = 0.25 + 0.45 * like;
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, 6 + 22 * like, 0, Math.PI * 2);
          ctx.fill();
          const twinkle = reduced ? 1 : 0.85 + 0.15 * Math.sin(now * 2.3 + star.angle * 5);
          const arm = (4 + 12 * like) * twinkle;
          ctx.globalAlpha = 0.5 + 0.4 * like;
          ctx.strokeStyle = warm;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x - arm, y);
          ctx.lineTo(x + arm, y);
          ctx.moveTo(x, y - arm);
          ctx.lineTo(x, y + arm);
          ctx.stroke();
        }
        // Disliked: a cool, hollow ring.
        if (dislike > 0.02) {
          ctx.globalAlpha = 0.25 + 0.4 * dislike;
          ctx.strokeStyle = cool;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 3 + 4 * dislike, 0, Math.PI * 2);
          ctx.stroke();
        }
        // The star itself.
        ctx.globalAlpha = 0.35 + 0.55 * Math.max(like, s.audible * 2);
        ctx.fillStyle = like > dislike ? warm : ink;
        ctx.beginPath();
        ctx.arc(x, y, 1.4 + 2.2 * like, 0, Math.PI * 2);
        ctx.fill();

        // Learning flash: an expanding ring when a vote moves this score.
        const age = now - star.flashAt;
        if (age >= 0 && age < FLASH_S) {
          const f = age / FLASH_S;
          ctx.globalAlpha = (1 - f) * 0.8;
          ctx.strokeStyle = star.flashSign > 0 ? warm : cool;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, 4 + 26 * f, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Label, outward from the star.
        const flashBoost = age >= 0 && age < FLASH_S ? 1 - age / FLASH_S : 0;
        const right = Math.cos(star.angle) >= 0;
        ctx.globalAlpha = Math.min(0.95, 0.22 + 0.6 * Math.max(Math.abs(s.taste), s.audible * 2, flashBoost));
        ctx.fillStyle = like > dislike ? warm : dislike > 0.1 ? cool : ink;
        ctx.textAlign = right ? 'left' : 'right';
        const lx = x + Math.cos(star.angle) * 14;
        const ly = y + Math.sin(star.angle) * 14;
        ctx.fillText(star.id.toUpperCase(), lx, ly);
      }
      ctx.globalAlpha = 1;
    };

    const loop = (nowMs: number) => {
      raf = requestAnimationFrame(loop);
      if (nowMs - lastFrame < 30) return; // ~30 fps is plenty for this layer
      lastFrame = nowMs;
      if (nowMs - lastPoll > POLL_MS) {
        lastPoll = nowMs;
        poll(nowMs / 1000);
      }
      draw(nowMs);
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      if (document.visibilityState === 'visible') raf = requestAnimationFrame(loop);
    };

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', sync);
    resize();
    sync();
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return <canvas ref={canvasRef} className="constellation" aria-hidden="true" />;
}
