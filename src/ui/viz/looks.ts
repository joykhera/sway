// Art direction from what's playing. Each feature group drives one aspect of the
// piece: genre sets the motion, mood the palette, texture the material, and the
// instrument adds an accent. Looks blend by feature weight, so a ramp between
// prompt sets becomes a visual morph.

export type Rgb = readonly [number, number, number];

export type Look = {
  /** Two flowing hues, plus a sparse highlight. */
  colorA: Rgb;
  colorB: Rgb;
  highlight: Rgb;
  background: Rgb;
  /** Tangential flow around the ring. */
  swirl: number;
  /** Curl-noise strength. */
  turbulence: number;
  /** Spatial frequency of the noise field. */
  noiseScale: number;
  /** How fast the noise field evolves. */
  flow: number;
  /** Overall particle speed. */
  speed: number;
  /** Ring thickness at respawn. */
  spread: number;
  /** Spring back toward the ring. */
  pull: number;
  /** Fraction of the trail kept after one second. */
  trail: number;
  /** Outward feedback drift per second (smoke rising off the ring). */
  drift: number;
  /** Feedback rotation, radians per second. */
  spin: number;
  /** Particle size in CSS pixels. */
  grain: number;
  /** Per-particle brightness. */
  density: number;
  /** Onset push. */
  burst: number;
};

type Motion = Pick<Look, 'swirl' | 'turbulence' | 'noiseScale' | 'flow' | 'speed' | 'trail' | 'drift' | 'spin' | 'burst'>;
type Palette = Pick<Look, 'colorA' | 'colorB' | 'highlight' | 'background'>;
type Material = Pick<Look, 'spread' | 'grain' | 'density' | 'pull'>;

const MOTION: Record<string, Motion> = {
  ambient: { swirl: 0.1, turbulence: 0.35, noiseScale: 1.1, flow: 0.5, speed: 0.55, trail: 0.6, drift: 0.05, spin: 0.02, burst: 0.4 },
  lofi: { swirl: 0.18, turbulence: 0.45, noiseScale: 1.5, flow: 0.7, speed: 0.65, trail: 0.45, drift: 0.04, spin: 0.03, burst: 0.9 },
  jazz: { swirl: 0.28, turbulence: 0.65, noiseScale: 1.9, flow: 1, speed: 0.8, trail: 0.35, drift: 0.07, spin: -0.05, burst: 1 },
  electronic: { swirl: 0.55, turbulence: 0.9, noiseScale: 3, flow: 1.8, speed: 1.15, trail: 0.15, drift: 0.12, spin: 0.1, burst: 1.8 },
  classical: { swirl: 0.2, turbulence: 0.4, noiseScale: 1.3, flow: 0.6, speed: 0.7, trail: 0.5, drift: 0.03, spin: 0.03, burst: 0.6 },
};

const PALETTE: Record<string, Palette> = {
  calm: { colorA: [0.16, 0.42, 0.95], colorB: [0.18, 0.82, 0.78], highlight: [0.85, 0.95, 1], background: [0.01, 0.02, 0.05] },
  dreamy: { colorA: [0.62, 0.48, 1], colorB: [1, 0.6, 0.62], highlight: [1, 0.92, 0.98], background: [0.03, 0.015, 0.05] },
  hopeful: { colorA: [1, 0.76, 0.3], colorB: [0.45, 0.92, 0.6], highlight: [1, 0.98, 0.85], background: [0.02, 0.028, 0.018] },
  melancholic: { colorA: [0.35, 0.38, 0.78], colorB: [0.7, 0.36, 0.5], highlight: [0.8, 0.82, 0.9], background: [0.015, 0.015, 0.03] },
  energetic: { colorA: [1, 0.18, 0.58], colorB: [0.1, 0.85, 1], highlight: [1, 1, 1], background: [0.03, 0, 0.04] },
};

const MATERIAL: Record<string, Material> = {
  sparse: { spread: 0.18, grain: 1.3, density: 0.7, pull: 2.5 },
  layered: { spread: 0.45, grain: 1.7, density: 1.1, pull: 1.8 },
  rhythmic: { spread: 0.3, grain: 1.4, density: 0.9, pull: 3.5 },
};

/** Small additive nudges per instrument. */
const ACCENT: Record<string, Partial<Look>> = {
  piano: { grain: 0.15, trail: 0.05 },
  synth: { spin: 0.04, flow: 0.2 },
  guitar: { turbulence: 0.12, swirl: 0.05 },
  strings: { swirl: 0.08, trail: 0.1, spread: 0.08 },
  percussion: { burst: 0.6, pull: 0.5 },
};

/** Sway's own warm ink: used for any group with nothing audible (e.g. the `?mock` tone). */
export const DEFAULT_LOOK: Look = {
  colorA: [0.94, 0.66, 0.38],
  colorB: [0.88, 0.48, 0.37],
  highlight: [0.93, 0.9, 0.85],
  background: [0.043, 0.039, 0.035],
  swirl: 0.2, turbulence: 0.4, noiseScale: 1.5, flow: 0.7, speed: 0.7, trail: 0.45, drift: 0.05, spin: 0.03, burst: 0.9,
  spread: 0.3, grain: 1.5, density: 0.9, pull: 2.8,
};

type Numeric = { [K in keyof Look]: Look[K] extends number ? K : never }[keyof Look];
type Colors = { [K in keyof Look]: Look[K] extends Rgb ? K : never }[keyof Look];
const NUMERIC = Object.keys(DEFAULT_LOOK).filter((k) => typeof DEFAULT_LOOK[k as keyof Look] === 'number') as Numeric[];
const COLORS = Object.keys(DEFAULT_LOOK).filter((k) => Array.isArray(DEFAULT_LOOK[k as keyof Look])) as Colors[];

/** Weight-averages one group's contributions; null when none of its features are audible. */
function blendGroup<T extends Partial<Look>>(table: Record<string, T>, features: Record<string, number>): Partial<Look> | null {
  let total = 0;
  const sums: Record<string, number | number[]> = {};
  for (const [id, entry] of Object.entries(table)) {
    const w = features[id];
    if (!w || !Number.isFinite(w) || w <= 0) continue;
    total += w;
    for (const [key, value] of Object.entries(entry)) {
      if (Array.isArray(value)) {
        const acc = (sums[key] as number[] | undefined) ?? [0, 0, 0];
        sums[key] = acc.map((v, i) => v + w * (value[i] as number));
      } else {
        sums[key] = ((sums[key] as number | undefined) ?? 0) + w * (value as number);
      }
    }
  }
  if (total === 0) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sums)) {
    out[key] = Array.isArray(value) ? value.map((v) => v / total) : value / total;
  }
  return out as Partial<Look>;
}

export function lookForBlend(features: Record<string, number>): Look {
  const look: Look = {
    ...DEFAULT_LOOK,
    ...blendGroup(MOTION, features),
    ...blendGroup(PALETTE, features),
    ...blendGroup(MATERIAL, features),
  };
  // Accents scale with the instrument's share of the whole blend.
  const total = Object.values(features).reduce((sum, w) => sum + (Number.isFinite(w) && w > 0 ? w : 0), 0);
  if (total > 0) {
    for (const [id, accent] of Object.entries(ACCENT)) {
      const share = (features[id] ?? 0) / total;
      if (!(share > 0)) continue;
      for (const [key, delta] of Object.entries(accent) as [Numeric, number][]) {
        look[key] += delta * share * 4;
      }
    }
  }
  return look;
}

/** Moves `from` toward `to` by fraction `t` (0..1). */
export function mixLook(from: Look, to: Look, t: number): Look {
  const out = { ...from };
  for (const key of NUMERIC) out[key] = from[key] + (to[key] - from[key]) * t;
  for (const key of COLORS) {
    const a = from[key];
    const b = to[key];
    out[key] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  return out;
}
