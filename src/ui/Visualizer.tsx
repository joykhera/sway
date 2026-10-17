import { useEffect, useRef } from 'react';
import type { MusicSessionController, Vote } from './contracts.ts';
import { BandTracker } from './viz/audio-bands.ts';
import { createFlowRenderer } from './viz/flow-renderer.ts';
import { DEFAULT_LOOK, lookForBlend, mixLook, type Rgb } from './viz/looks.ts';

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

export type FlowVisualizerProps = VisualizerProps & {
  /** Where the piece listens: the output spectrum and what's estimated to be audible. */
  source?: Pick<MusicSessionController, 'getAnalyser' | 'getAudibleFeatures'>;
  /** WebGL failed or the context was lost; the caller should fall back to the ring. */
  onUnavailable?: () => void;
};

/** How often to re-read the audible blend; the look itself eases continuously. */
const FEATURE_POLL_MS = 250;
/** Time constant (s) for easing toward a new look; Lyria ramps take ~8 s. */
const LOOK_EASE_S = 1.8;

/** Dev-only preview without Lyria: `?look=jazz,calm,layered` pins the audible blend. */
function previewFeatures(): Record<string, number> | null {
  if (!import.meta.env.DEV) return null;
  const ids = new URLSearchParams(window.location.search).get('look');
  return ids ? Object.fromEntries(ids.split(',').map((id) => [id.trim(), 1])) : null;
}

function hexToRgb(hex: string, fallback: Rgb): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : fallback;
}

/**
 * Full-bleed generative piece: ~65k GPU particles flowing around the ring
 * through a curl-noise field, leaving drifting feedback trails. It listens to
 * the music (bass swells the ring, mids stir it, highs sparkle, onsets push
 * outward) and takes its art direction from what's playing (see viz/looks.ts).
 * Votes bloom warm or tighten cool.
 */
export function FlowVisualizer({ active, lastVote, source, onUnavailable }: FlowVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The loop reads these through refs so it never restarts mid-piece.
  const voteRef = useRef(lastVote);
  const activeRef = useRef(active);
  const sourceRef = useRef(source);
  const failRef = useRef(onUnavailable);
  // PlayerScreen clears lastVote after a short flash; keep the last one so its bloom can finish.
  if (lastVote) voteRef.current = lastVote;
  activeRef.current = active;
  sourceRef.current = source;
  failRef.current = onUnavailable;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createFlowRenderer(canvas, { onContextLost: () => failRef.current?.() });
    if (!renderer) {
      failRef.current?.();
      return;
    }

    const css = getComputedStyle(document.documentElement);
    const warm = hexToRgb(css.getPropertyValue('--accent'), [0.94, 0.66, 0.38]);
    const cool = hexToRgb(css.getPropertyValue('--accent-cool'), [0.49, 0.78, 0.89]);
    const bands = new BandTracker();
    const preview = previewFeatures();
    let look = lookForBlend(preview ?? sourceRef.current?.getAudibleFeatures?.() ?? {});
    let target = look;
    let lastPoll = 0;
    const start = performance.now();
    let last = start;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const rect = canvas.getBoundingClientRect();
      renderer.resize(rect.width * dpr, rect.height * dpr, dpr);
    };

    let raf = 0;
    const loop = (nowMs: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((nowMs - last) / 1000, 0.1);
      last = nowMs;
      const time = (nowMs - start) / 1000;
      const src = sourceRef.current;
      if (nowMs - lastPoll > FEATURE_POLL_MS) {
        lastPoll = nowMs;
        const features = preview ?? src?.getAudibleFeatures?.();
        target = features && Object.keys(features).length ? lookForBlend(features) : DEFAULT_LOOK;
      }
      look = mixLook(look, target, 1 - Math.exp(-dt / LOOK_EASE_S));
      // `at` is a Date.now() timestamp (see PlayerScreen).
      const vote = voteRef.current;
      const age = vote ? (Date.now() - vote.at) / 1000 : Infinity;
      const pulse = age >= 0 && age < 6 ? Math.exp(-age * 1.1) : 0;
      renderer.render({
        time,
        dt,
        bands: bands.update(src?.getAnalyser?.() ?? null, dt, time),
        look,
        up: vote?.v === 'up' ? pulse : 0,
        down: vote?.v === 'down' ? pulse : 0,
        active: activeRef.current,
        warm,
        cool,
      });
    };

    // Pause entirely while the tab is hidden; resume without a time jump.
    const sync = () => {
      cancelAnimationFrame(raf);
      if (document.visibilityState === 'visible') {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener('visibilitychange', sync);
    resize();
    sync();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="visualizer visualizer--flow" aria-hidden="true" />;
}
