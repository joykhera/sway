import { useEffect, useRef } from 'react';
import type { Vote } from './contracts.ts';

export type VisualizerProps = {
  /** Session view is live; the ring breathes only while active AND the tab is visible. */
  active: boolean;
  /** Triggers a decaying radius/color pulse — warm for 'up', cool for 'down'. */
  lastVote: { v: Vote; at: number } | null;
};

const POINTS = 180;
const TAU = Math.PI * 2;

const FALLBACK_INK = '#ece5d8';
const FALLBACK_WARM = '#f0a860';
const FALLBACK_COOL = '#7ec8e3';

/** jsdom exposes <canvas> but no 2d context (calling it logs a "not implemented" error). */
function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return null;
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/**
 * The breathing generative ring — pure time-driven art, intentionally not an audio
 * analyser. A ~180-point closed curve whose radius is modulated by three slow,
 * incommensurate sines; votes add a decaying hue pulse. Layered strokes fake a soft
 * glow. Reduced motion renders a single static ring; inactive renders it dimmed.
 */
export function Visualizer({ active, lastVote }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const voteRef = useRef(lastVote);
  const drawRef = useRef<() => void>(() => {});

  // Keep the vote visible to the running loop without restarting the effect.
  useEffect(() => {
    voteRef.current = lastVote;
    drawRef.current(); // repaint once so a static/reduced-motion ring still shows the pulse
  }, [lastVote]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = get2dContext(canvas);
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ring-ink').trim() || FALLBACK_INK;
    const warm = css.getPropertyValue('--accent').trim() || FALLBACK_WARM;
    const cool = css.getPropertyValue('--accent-cool').trim() || FALLBACK_COOL;

    const reduced =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    const motion = () => active && !reduced?.matches;

    let dpr = 1;

    const draw = () => {
      // Read back the backing size (kept in sync by `resize`) instead of
      // getBoundingClientRect — no layout work on the animation path.
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (w <= 0 || h <= 0) return;

      const cx = w / 2;
      const cy = h / 2;
      const baseR = Math.min(w, h) * 0.335;

      // Decaying vote pulse (~visible for ~1s). `at` is a Date.now() timestamp —
      // keep the same clock here rather than the rAF/performance clock.
      const vote = voteRef.current;
      let pulse = 0;
      let pulseColor = warm;
      if (vote) {
        const age = (Date.now() - vote.at) / 1000;
        if (age >= 0 && age < 4) {
          pulse = Math.exp(-age * 3.0);
          pulseColor = vote.v === 'down' ? cool : warm;
        }
      }

      const t = motion() ? performance.now() / 1000 : 0; // frozen time = static ring
      const dim = active ? 1 : 0.35;

      // Thin baseline ring.
      ctx.globalAlpha = 0.09 * dim;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 1.06, 0, TAU);
      ctx.stroke();

      // Modulated ring: three integer-frequency sines around the circle (so the curve
      // closes) driven by incommensurate temporal rates 0.61 / 0.437 / 0.277 rad·s⁻¹.
      const path = new Path2D();
      const breatheScale = motion() ? 1 : 0.4;
      for (let i = 0; i <= POINTS; i++) {
        const a = (i / POINTS) * TAU;
        const breathe =
          0.045 * Math.sin(2 * a + t * 0.61 + 1.7) +
          0.03 * Math.sin(3 * a - t * 0.437 + 4.1) +
          0.021 * Math.sin(5 * a + t * 0.277 + 0.4);
        const ripple = pulse * 0.05 * Math.sin(6 * a - t * 2.4);
        const r = baseR * (1 + breathe * breatheScale + pulse * 0.05 + ripple);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();

      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // Soft halo + mid glow (layered strokes instead of shadowBlur).
      ctx.globalAlpha = 0.05 * dim + 0.05 * pulse;
      ctx.lineWidth = Math.max(6, baseR * 0.1);
      ctx.stroke(path);
      ctx.globalAlpha = 0.12 * dim + 0.1 * pulse;
      ctx.lineWidth = Math.max(2.5, baseR * 0.03);
      ctx.stroke(path);
      // Vote hue layer.
      if (pulse > 0.01) {
        ctx.globalAlpha = Math.min(0.6, pulse * 0.55);
        ctx.strokeStyle = pulseColor;
        ctx.lineWidth = Math.max(2, baseR * 0.022);
        ctx.stroke(path);
        ctx.strokeStyle = ink;
      }
      // Hairline core.
      ctx.globalAlpha = 0.8 * dim;
      ctx.lineWidth = 1.4;
      ctx.stroke(path);

      // Faint center point that swells briefly with a vote.
      ctx.beginPath();
      ctx.arc(cx, cy, 1.6 + pulse * 2.2, 0, TAU);
      ctx.globalAlpha = Math.min(0.9, 0.22 * dim + pulse * 0.6);
      ctx.fillStyle = pulse > 0.4 ? pulseColor : ink;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    drawRef.current = draw;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      draw();
    };

    const canAnimate = typeof requestAnimationFrame === 'function';
    let raf = 0;
    let running = false;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    const sync = () => {
      const want =
        motion() && canAnimate && document.visibilityState === 'visible';
      if (want && !running) {
        running = true;
        raf = requestAnimationFrame(loop);
      } else if (!want && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
      if (!want) draw();
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
    } else {
      window.addEventListener('resize', resize);
    }
    document.addEventListener('visibilitychange', sync);
    if (reduced && typeof reduced.addEventListener === 'function') {
      reduced.addEventListener('change', sync);
    }

    resize();
    sync();

    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', sync);
      if (reduced && typeof reduced.removeEventListener === 'function') {
        reduced.removeEventListener('change', sync);
      }
      drawRef.current = () => {};
    };
  }, [active]);

  return <canvas ref={canvasRef} className="visualizer" aria-hidden="true" />;
}
