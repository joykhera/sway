// The session portrait: one listening session drawn like the rings of a tree.
// Time runs outward from the centre; each ring takes the colours of what was
// playing then, and wobbles with how loud it was. Likes glow warm and dislikes
// mark cool, at the moment they happened.
import { describeBlend, topTaste } from './describe.ts';
import type { Rgb } from './looks.ts';
import type { SessionLog, SessionSample } from './session-log.ts';

export const PORTRAIT_WIDTH = 1080;
export const PORTRAIT_HEIGHT = 1350;
const CX = PORTRAIT_WIDTH / 2;
const CY = 560;
const R0 = 64;
const R1 = 440;
/** More rings than this get merged; finer detail isn't visible at this size. */
const MAX_RINGS = 480;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const css = (c: Rgb, alpha = 1) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha})`;

/** Averages runs of samples down to at most `max` rings. */
export function ringsOf(samples: SessionSample[], max = MAX_RINGS): SessionSample[] {
  if (samples.length <= max) return samples;
  const size = samples.length / max;
  return Array.from({ length: max }, (_, i) => {
    const run = samples.slice(Math.floor(i * size), Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1));
    const avg = (pick: (s: SessionSample) => number) => run.reduce((sum, s) => sum + pick(s), 0) / run.length;
    const avgRgb = (pick: (s: SessionSample) => Rgb): Rgb => [avg((s) => pick(s)[0]), avg((s) => pick(s)[1]), avg((s) => pick(s)[2])];
    return { t: avg((s) => s.t), energy: avg((s) => s.energy), colorA: avgRgb((s) => s.colorA), colorB: avgRgb((s) => s.colorB), label: run[0]!.label };
  });
}

/** The caption under the rings. */
export function portraitCaption(log: SessionLog, locale?: string): { date: string; stats: string; leaning: string } {
  const minutes = Math.max(1, Math.round(log.duration / 60));
  const likes = log.votes.filter((v) => v.v === 'up').length;
  const dislikes = log.votes.length - likes;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const top = topTaste(log.taste);
  // With no learned taste yet, name what was heard most.
  const heard = top.length ? '' : describeBlend(
    log.samples.reduce<Record<string, number>>((acc, s) => {
      for (const part of s.label.split(' · ')) if (part) acc[part] = (acc[part] ?? 0) + 1;
      return acc;
    }, {}),
  );
  return {
    date: new Date(log.startedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' }),
    stats: [`${minutes} min`, plural(likes, 'like'), plural(dislikes, 'dislike')].join(' · '),
    leaning: top.length ? `leaned toward  ${top.join(' · ')}` : heard ? `wandered through  ${heard}` : 'still exploring',
  };
}

export async function drawPortrait(canvas: HTMLCanvasElement, log: SessionLog, colors: { ink: Rgb; muted: Rgb; warm: Rgb; cool: Rgb }): Promise<void> {
  canvas.width = PORTRAIT_WIDTH;
  canvas.height = PORTRAIT_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Canvas text only uses web fonts that have finished loading.
  try {
    await Promise.all([
      document.fonts.load('italic 72px "Instrument Serif"'),
      document.fonts.load('400 22px "JetBrains Mono"'),
    ]);
  } catch {
    /* system fallbacks are fine */
  }

  const rings = ringsOf(log.samples);
  const tint = rings.reduce<[number, number, number]>((acc, r) => [acc[0] + r.colorA[0], acc[1] + r.colorA[1], acc[2] + r.colorA[2]], [0, 0, 0])
    .map((v) => v / Math.max(1, rings.length)) as unknown as Rgb;

  // Ground: warm ink with a faint halo in the session's average colour.
  ctx.fillStyle = '#0b0a09';
  ctx.fillRect(0, 0, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  const halo = ctx.createRadialGradient(CX, CY, 0, CX, CY, R1 * 1.5);
  halo.addColorStop(0, css(tint, 0.16));
  halo.addColorStop(1, css(tint, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);

  // Rings, oldest at the centre. Additive, so dense passages glow.
  const duration = Math.max(log.duration, 1);
  const radiusAt = (t: number) => R0 + (R1 - R0) * Math.min(1, t / duration);
  const width = Math.min(5, Math.max(1, ((R1 - R0) / rings.length) * 1.4));
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  rings.forEach((ring, i) => {
    const r = radiusAt(ring.t);
    const gradient = ctx.createConicGradient(i * 0.11, CX, CY);
    gradient.addColorStop(0, css(ring.colorA));
    gradient.addColorStop(0.5, css(ring.colorB));
    gradient.addColorStop(1, css(ring.colorA));
    ctx.strokeStyle = gradient;
    ctx.globalAlpha = 0.18 + 0.5 * ring.energy;
    ctx.beginPath();
    for (let k = 0; k <= 180; k++) {
      const a = (k / 180) * Math.PI * 2;
      const wobble = ring.energy * (10 * Math.sin(3 * a + i * 0.37) + 5 * Math.sin(7 * a - i * 0.21));
      const x = CX + Math.cos(a) * (r + wobble);
      const y = CY + Math.sin(a) * (r + wobble);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  // Votes where they happened: likes glow warm, dislikes are small cool rings.
  log.votes.forEach((vote, i) => {
    const r = radiusAt(vote.t);
    const a = i * GOLDEN_ANGLE;
    const x = CX + Math.cos(a) * r;
    const y = CY + Math.sin(a) * r;
    if (vote.v === 'up') {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 22);
      glow.addColorStop(0, css(colors.warm, 0.9));
      glow.addColorStop(1, css(colors.warm, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = css(colors.ink);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = css(colors.cool);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  // Caption.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const caption = portraitCaption(log);
  ctx.fillStyle = css(colors.ink);
  ctx.font = 'italic 72px "Instrument Serif", Georgia, serif';
  ctx.fillText('sway', CX, 1120);
  ctx.font = '400 22px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = css(colors.muted);
  ctx.fillText(`${caption.date}  ·  ${caption.stats}`, CX, 1172);
  ctx.fillStyle = css(colors.warm);
  ctx.fillText(caption.leaning, CX, 1222);
  ctx.font = '400 16px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = css(colors.muted, 0.7);
  ctx.fillText('infinite music that learned you', CX, 1296);
}
