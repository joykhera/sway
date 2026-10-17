import { useEffect, useRef } from 'react';
import type {
  MusicSessionController,
  MusicSignature,
  StreamLevels,
  Vote,
} from './contracts.ts';

export type VisualizerProps = {
  /** Session controller — stats (~10 Hz) and signature feed the organism. Optional: without it the canvas breathes on ambient drift alone. */
  controller?: MusicSessionController;
  /** Session view is live; idle rests the organism as a dim breathing outline (~30%). */
  active: boolean;
  /** Directional pulse — a warm bloom on the up side, a cool ripple on the down side. */
  lastVote?: { v: Vote; at: number } | null;
};

const POINTS = 112;
const TAU = Math.PI * 2;
const MAX_PARTICLES = 36;
/** Morph time constant — ~95% settled by 2 s, so steering is felt but never snaps. */
const MORPH_TAU = 0.65;
/** Fixed timestamp for the reduced-motion render — a static organism, still alive. */
const FIXED_T = 12.7;
/** Side of the ring each vote blooms on — matches the thumbs layout (up left, down right). */
const UP_SIDE = Math.PI;
const DOWN_SIDE = 0;

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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Deterministic 0..1 hash — the same signature always grows the same organism. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * The morphable anatomy of the organism. `current` eases toward `target` every
 * frame with t = 1 - exp(-dt/τ); a signature change rewrites `target` only.
 */
type OrganismParams = {
  /** Degrees of bias on the pitch-driven warm↔cool hue axis. */
  hueBias: number;
  /** Dominant polar harmonic of the brightness wobble (3..8). */
  wobbleFreq: number;
  /** How strongly brightness drives the wobble. */
  wobbleMix: number;
  /** Hairline core width multiplier. */
  ringWidth: number;
  /** Orbital drift particle count. */
  particles: number;
  /** Breath tempo multiplier. */
  breathRate: number;
};

const BASE_PARAMS: OrganismParams = {
  hueBias: 0,
  wobbleFreq: 5,
  wobbleMix: 0.7,
  ringWidth: 1,
  particles: 14,
  breathRate: 1,
};

/** Map a MusicSignature to a target anatomy — hash for spread, keywords for intent. */
function paramsForSignature(sig: MusicSignature | undefined): OrganismParams {
  const text = [sig?.genre, sig?.instrument, sig?.mood, sig?.texture, sig?.focus]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return { ...BASE_PARAMS };
  const h = (salt: string) => hash01(`${text}·${salt}`);
  const p: OrganismParams = {
    hueBias: (h('hue') - 0.5) * 56, // ±28°
    wobbleFreq: 3 + h('freq') * 5,
    wobbleMix: 0.4 + h('mix') * 0.6,
    ringWidth: 0.85 + h('width') * 1.1,
    particles: 8 + Math.round(h('dust') * (MAX_PARTICLES - 8)),
    breathRate: 0.7 + h('breath') * 0.75,
  };
  if (/calm|ambient|soft|gentle|sparse|minimal|slow/.test(text)) {
    p.wobbleFreq -= 1.5;
    p.particles = Math.round(p.particles * 0.5);
    p.breathRate *= 0.72;
    p.ringWidth *= 1.3;
  }
  if (/energetic|driving|aggressive|intense|dense|hype|fast/.test(text)) {
    p.wobbleFreq += 1.5;
    p.particles = Math.round(p.particles * 1.5);
    p.breathRate *= 1.3;
  }
  if (/warm|golden|amber|sun|jazz|soul|analog/.test(text)) p.hueBias -= 14;
  if (/cool|cold|ice|blue|night|techno|electro|digital/.test(text)) p.hueBias += 14;
  if (/granular|noisy|dusty|textured|lofi|lo-fi/.test(text)) {
    p.wobbleMix = Math.min(1, p.wobbleMix + 0.25);
    p.particles = Math.round(p.particles * 1.3);
  }
  p.hueBias = clamp(p.hueBias, -40, 40);
  p.wobbleFreq = clamp(p.wobbleFreq, 3, 8);
  p.wobbleMix = clamp(p.wobbleMix, 0.3, 1);
  p.particles = clamp(p.particles, 0, MAX_PARTICLES);
  p.breathRate = clamp(p.breathRate, 0.5, 1.7);
  p.ringWidth = clamp(p.ringWidth, 0.7, 2.2);
  return p;
}

/**
 * The living organism at the center of the stage: a closed polar curve (~112
 * points) whose radius combines a slow breath, an energy-driven swell, and a
 * per-point harmonic wobble modulated by spectral brightness. PitchHz slides
 * the hue along a warm-amber ↔ cool-blue axis (kept pastel so it never gets
 * garish). Votes send a directional ripple across the voted side. When the
 * controller's signature changes, the organism crossfades its anatomy over ~2 s.
 *
 * Stats are written straight to canvas via refs — React never re-renders per
 * tick. Reduced motion renders a single static frame; a hidden tab pauses the
 * loop; idle dims the breathing outline to ~30%.
 */
export function Visualizer({ controller, active, lastVote = null }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const voteRef = useRef(lastVote);
  const drawRef = useRef<() => void>(() => { });

  // Data-plane refs — mutated by subscriptions, read by the draw loop.
  const levelsRef = useRef<StreamLevels | null>(null);
  const hasStatsRef = useRef(false);
  const stressRef = useRef(0); // brief turbulence spike on fresh underruns
  const underrunsRef = useRef(0);
  const paramsCur = useRef<OrganismParams>({ ...BASE_PARAMS });
  const paramsTgt = useRef<OrganismParams>({ ...BASE_PARAMS });
  const sigSeenRef = useRef(false);

  // Keep the vote visible to the running loop without restarting the effect.
  useEffect(() => {
    voteRef.current = lastVote;
    drawRef.current(); // repaint once so a static/reduced-motion ring still shows the pulse
  }, [lastVote]);

  // Subscriptions live apart from the canvas effect so they register even when
  // no 2d context exists (jsdom) — the refs simply feed nothing until paint.
  useEffect(() => {
    if (!controller) return;
    sigSeenRef.current = false;
    const offState = controller.subscribe?.((state) => {
      const next = paramsForSignature(state.signature);
      if (!sigSeenRef.current) {
        sigSeenRef.current = true;
        paramsCur.current = next; // first emit snaps — no morph away from defaults
      }
      paramsTgt.current = next;
      drawRef.current(); // repaint once so a static ring still reflects the new anatomy
    });
    const offStats = controller.subscribeStats?.((levels) => {
      if (levels.underruns > underrunsRef.current) {
        stressRef.current = Math.min(1, stressRef.current + 0.6);
      }
      underrunsRef.current = levels.underruns;
      levelsRef.current = levels;
      hasStatsRef.current = true;
    });
    return () => {
      offState?.();
      offStats?.();
      hasStatsRef.current = false;
      levelsRef.current = null;
    };
  }, [controller]);

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

    // Fixed seeds for the orbital drift — only the count morphs.
    const seeds = Array.from({ length: MAX_PARTICLES }, (_, i) => ({
      orb: 0.72 + hash01(`orb${i}`) * 0.5, // orbit radius × baseR
      speed: (hash01(`spd${i}`) - 0.5) * 0.22, // rad/s, either direction
      phase: hash01(`ph${i}`) * TAU,
      size: 0.7 + hash01(`sz${i}`) * 1.3,
      tw: 0.7 + hash01(`tw${i}`) * 0.9, // twinkle rate
    }));

    // Smoothed live levels — stats tick at ~10 Hz, we ease at frame rate.
    const live = { energy: 0, brightness: 0.45, pitchT: 0.35 };
    let dpr = 1;
    let lastT = 0;

    const draw = () => {
      // Read back the backing size (kept in sync by `resize`) — no layout work
      // on the animation path.
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (w <= 0 || h <= 0) return;

      const now = performance.now() / 1000;
      const dt = clamp(now - lastT, 0, 0.1);
      lastT = now;
      const frozen = reduced?.matches ?? false;
      const t = frozen ? FIXED_T : now;
      const dim = active ? 1 : 0.3;

      // ---- signature morph: ease current anatomy toward target ----
      const cur = paramsCur.current;
      const tgt = paramsTgt.current;
      const kMorph = frozen ? 1 : 1 - Math.exp(-dt / MORPH_TAU);
      cur.hueBias += (tgt.hueBias - cur.hueBias) * kMorph;
      cur.wobbleFreq += (tgt.wobbleFreq - cur.wobbleFreq) * kMorph;
      cur.wobbleMix += (tgt.wobbleMix - cur.wobbleMix) * kMorph;
      cur.ringWidth += (tgt.ringWidth - cur.ringWidth) * kMorph;
      cur.particles += (tgt.particles - cur.particles) * kMorph;
      cur.breathRate += (tgt.breathRate - cur.breathRate) * kMorph;

      // ---- live levels: real stats or a gentle ambient drift ----
      const stats = hasStatsRef.current ? levelsRef.current : null;
      let eT: number;
      let bT: number;
      let pT: number | null;
      if (stats) {
        eT = clamp(stats.energy * 1.5, 0, 1);
        bT = clamp((stats.brightnessHz - 500) / 6500, 0, 1); // ~0.5–7 kHz → 0..1
        pT =
          stats.pitchHz && stats.pitchHz > 20
            ? clamp(Math.log2(stats.pitchHz / 55) / 4, 0, 1) // 55–880 Hz → 0..1
            : null;
      } else {
        // No stats feed — the organism still breathes on its own.
        const amp = active ? 0.3 : 0.17;
        eT = amp + 0.08 * Math.sin(t * 0.23 + 1.2) + 0.05 * Math.sin(t * 0.09);
        bT = 0.45 + 0.18 * Math.sin(t * 0.11 + 4.0);
        pT = 0.35 + 0.08 * Math.sin(t * 0.07 + 2.2);
      }
      const kFast = frozen ? 1 : 1 - Math.exp(-dt / 0.16);
      const kSlow = frozen ? 1 : 1 - Math.exp(-dt / 0.45);
      live.energy += (eT - live.energy) * kFast;
      live.brightness += (bT - live.brightness) * kSlow;
      if (pT !== null) live.pitchT += (pT - live.pitchT) * kSlow;
      stressRef.current *= Math.exp(-dt / 0.8);
      const stress = stressRef.current;

      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.3;

      // Pitch slides hue amber→blue; the signature nudges it. Kept pastel.
      const hue = (((lerp(36, 208, live.pitchT) + cur.hueBias) % 360) + 360) % 360;
      const hueInk = `hsl(${hue.toFixed(1)} 64% 66%)`;
      const hueFill = (a: number, s = 58, l = 55) =>
        `hsla(${hue.toFixed(1)}, ${s}%, ${l}%, ${clamp(a, 0, 1).toFixed(3)})`;

      // ---- vote pulse: directional ripple on the voted side ----
      const vote = voteRef.current;
      let vp = 0;
      let vAge = 0;
      let vSide = UP_SIDE;
      let vCol = warm;
      if (vote) {
        vAge = (Date.now() - vote.at) / 1000; // same clock the producer used
        if (vAge >= 0 && vAge < 3) {
          vp = Math.exp(-vAge * 2.3);
          vSide = vote.v === 'up' ? UP_SIDE : DOWN_SIDE;
          vCol = vote.v === 'up' ? warm : cool;
        }
      }
      const angDiff = (a: number) =>
        Math.atan2(Math.sin(a - vSide), Math.cos(a - vSide));
      const sideWeight = (a: number) => {
        const d = angDiff(a);
        return Math.exp(-(d * d) / 0.5);
      };

      // ---- the body: a closed polar curve ----
      const breath =
        (active ? 0.034 : 0.022) * Math.sin(t * 0.42 * cur.breathRate + 1.7);
      const swell =
        live.energy * (0.085 + 0.03 * Math.sin(t * 0.9 * cur.breathRate));
      const wobGain = cur.wobbleMix * (0.3 + 0.7 * live.brightness);
      const f0 = Math.floor(cur.wobbleFreq);
      const fFrac = cur.wobbleFreq - f0;
      // Integer harmonics keep the curve closed; crossfade floor→ceil so the
      // morph slides between harmonics instead of jumping.
      const wobble = (a: number, f: number) =>
        0.03 * Math.sin(f * a + t * 0.83 + 1.7) +
        0.019 * Math.sin((f + 2) * a - t * 0.57 + 4.1) +
        0.011 * Math.sin((f + 4) * a + t * 0.41 + 0.4);
      const pts: Array<[number, number]> = new Array(POINTS + 1);
      for (let i = 0; i <= POINTS; i++) {
        const a = (i / POINTS) * TAU;
        let r =
          1 + breath + swell + wobGain * lerp(wobble(a, f0), wobble(a, f0 + 1), fFrac);
        if (vp > 0.003) {
          r += vp * sideWeight(a) * (0.085 + 0.05 * Math.sin(9 * a - vAge * 10));
        }
        if (stress > 0.01) r += stress * 0.012 * Math.sin(23 * a + t * 7.3);
        const rr = base * r;
        pts[i] = [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
      }
      const path = new Path2D();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;
        if (i === 0) path.moveTo(p[0], p[1]);
        else path.lineTo(p[0], p[1]);
      }
      path.closePath();

      // ---- inner aura: a soft energy-lit glow, part of the same body ----
      const auraR = base * (1.18 + 0.22 * live.energy);
      const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, auraR);
      aura.addColorStop(
        0,
        hueFill(0.11 * dim * (0.3 + 0.7 * live.energy), 58, 52),
      );
      aura.addColorStop(0.55, hueFill(0.045 * dim, 52, 42));
      aura.addColorStop(1, hueFill(0));
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(cx, cy, auraR, 0, TAU);
      ctx.fill();

      // ---- orbital drift: faint motes bound to the body, never a soup ----
      const nFull = Math.floor(cur.particles);
      const n = Math.min(MAX_PARTICLES, Math.ceil(cur.particles));
      for (let i = 0; i < n; i++) {
        const s = seeds[i];
        if (!s) continue;
        const ang = s.phase + t * s.speed;
        const rr = base * s.orb * (1 + breath * 0.6 + swell * 0.5);
        const twinkle = 0.5 + 0.5 * Math.sin(t * s.tw + s.phase * 3);
        const born = i < nFull ? 1 : cur.particles - nFull; // fade the morphing extra in
        ctx.globalAlpha =
          dim * (0.05 + 0.3 * live.energy) * (0.35 + 0.65 * twinkle) * born;
        ctx.fillStyle = i % 3 === 0 ? ink : hueFill(0.9, 64, 70);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, s.size, 0, TAU);
        ctx.fill();
      }

      // ---- faint baseline orbit ----
      ctx.globalAlpha = 0.07 * dim;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, base * 1.32, 0, TAU);
      ctx.stroke();

      // ---- layered glow: wide halo → mid glow → ink body → hairline core ----
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = (0.05 + 0.04 * live.energy) * dim;
      ctx.strokeStyle = hueInk;
      ctx.lineWidth = Math.max(8, base * 0.14);
      ctx.stroke(path);
      ctx.globalAlpha = (0.11 + 0.1 * live.energy) * dim;
      ctx.lineWidth = Math.max(3, base * 0.045);
      ctx.stroke(path);
      ctx.globalAlpha = 0.3 * dim;
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.8, base * 0.016) * cur.ringWidth;
      ctx.stroke(path);
      ctx.globalAlpha = 0.85 * dim;
      ctx.lineWidth = 1.3 * cur.ringWidth;
      ctx.stroke(path);

      // ---- vote: bloom on the voted sector + a ripple swelling outward ----
      const span = 1.05; // radians of ring lit by the vote
      if (vp > 0.01) {
        const sector = new Path2D();
        let pen = false;
        for (let i = 0; i <= POINTS; i++) {
          const a = (i / POINTS) * TAU;
          const p = pts[i];
          if (!p) continue;
          if (Math.abs(angDiff(a)) <= span) {
            if (pen) sector.lineTo(p[0], p[1]);
            else {
              sector.moveTo(p[0], p[1]);
              pen = true;
            }
          } else {
            pen = false;
          }
        }
        ctx.globalAlpha = Math.min(0.75, vp * 0.8);
        ctx.strokeStyle = vCol;
        ctx.lineWidth = Math.max(2.5, base * 0.028);
        ctx.stroke(sector);
        // Expanding arc — the ripple leaving the body.
        ctx.globalAlpha = vp * 0.45;
        ctx.lineWidth = Math.max(1.2, base * 0.008);
        ctx.beginPath();
        ctx.arc(cx, cy, base * (1 + vAge * 0.6), vSide - span * 0.9, vSide + span * 0.9);
        ctx.stroke();
        // Nucleus flash.
        ctx.beginPath();
        ctx.arc(cx, cy, 2 + vp * 3, 0, TAU);
        ctx.globalAlpha = Math.min(0.9, 0.2 * dim + vp * 0.7);
        ctx.fillStyle = vCol;
        ctx.fill();
      } else {
        // Quiet nucleus that swells with energy.
        ctx.beginPath();
        ctx.arc(cx, cy, 1.6 + live.energy * 2.4, 0, TAU);
        ctx.globalAlpha = Math.min(0.85, 0.2 * dim + live.energy * 0.3);
        ctx.fillStyle = ink;
        ctx.fill();
      }
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
      // The organism breathes whenever the tab is visible and motion is
      // allowed — idle only dims it. Hidden tabs and reduced motion pause.
      const want =
        canAnimate && !(reduced?.matches ?? false) &&
        document.visibilityState === 'visible';
      if (want && !running) {
        running = true;
        lastT = performance.now() / 1000;
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
      drawRef.current = () => { };
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className="visualizer"
      style={{ width: '100%', height: '100%' }}
      aria-hidden="true"
    />
  );
}
