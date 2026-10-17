import { useEffect, useRef } from 'react';
import type { MusicSessionController, Vote } from './contracts.ts';
import { BandTracker, type Bands } from './viz/audio-bands.ts';
import { FEATURE_GROUPS, GROUP_IDS, normalizeTaste } from './viz/describe.ts';
import { advanceArrivedPoem, layoutRim, pickRimWord, RING_IN_RIM, steeredPoem, type ArrivedPoem, type RimPlace, type TasteField } from './viz/verse.ts';

export type TasteVerseProps = {
  source: Pick<MusicSessionController, 'getTaste' | 'getAudibleFeatures' | 'getAnalyser' | 'getSteer'>;
  /** Ring radius as a fraction of half the viewport height; the poem sits inside it. */
  ringFraction: number;
  /** Each new vote sends the words you were hearing out to the ring. */
  lastVote: { v: Vote; at: number } | null;
  /** Shared with the flow piece, so the smoke can reach for the words. */
  field?: TasteField;
  /** The fallback ring's box: it sits in the stage rather than mid-screen, at a third of its width. */
  anchor?: () => DOMRect | null | undefined;
  /** Tapping a word in the ring (anywhere in its slice) steers toward it. Omit to make the ring read-only. */
  onPick?: (id: string) => void;
};

/** Re-read taste and the audible blend this often; drawing eases between reads. */
const POLL_MS = 300;
/** A score change this large (normalized) since the last read flashes the word. */
const FLASH_DELTA = 0.04;
const FLASH_S = 1.6;
/** Leave the bottom of the circle free for the thumbs and moments. */
const GAP_RADIANS = (84 * Math.PI) / 180;
/** Lettering radius as a fraction of half the viewport height (clamped by width). */
const RIM_FRACTION = 0.78;
/** Rim type sizes (px): neutral, and how much a full like adds. */
const RIM_SIZE = 14;
const RIM_GROW = 15;
/** How long a word takes to fly from the poem to the ring, and the stagger per letter. */
const FLIGHT_S = 1.5;
const LETTER_DELAY_S = 0.045;
/** How far from the lettering (px) a tap still picks a word. */
const PICK_BAND = 44;
/** Elements whose taps are their own; the ring ignores them. */
const OWN_CLICKS = 'button, a, input, select, textarea, label, [role="dialog"], .hud > *, .music-request';
/** Glyphs are measured once at this size and scaled. */
const REF_PX = 100;
const SERIF = '"Instrument Serif", Georgia, "Times New Roman", serif';

type Rgb = [number, number, number];

type RimWord = {
  id: string;
  group: string;
  taste: number;
  audible: number;
  shownTaste: number;
  shownAudible: number;
  /** Eased 0..1: the strike-through drawn across a disliked word. */
  strike: number;
  flashAt: number;
  flashSign: number;
};

type PoemWord = {
  id: string;
  share: number;
  targetShare: number;
  /** Eased 0..1 toward `target`; letters appear one after another as it rises. */
  presence: number;
  target: number;
  /** Where the line was last set (px), so a vote can lift it from there. */
  x: number;
  y: number;
  size: number;
  /** After a vote the word is away in flight until this time (s). */
  awayUntil: number;
  /**
   * 0..1 how much of the word is inked, letter by letter. While a change is on
   * its way, arriving words are ghosts that ink in with its real progress and
   * leaving words give their ink back; 1 otherwise.
   */
  ink: number;
  inkTarget: number;
};

type Glyph = { ch: string; x: number; y: number; rot: number; size: number };

type Flight = { id: string; start: number; sign: number; italic: boolean; from: Glyph[] };

/** jsdom exposes <canvas> but no 2d context (calling it logs a "not implemented" error). */
function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return null;
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function hexToRgb(hex: string, fallback: Rgb): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : fallback;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgb = (c: Rgb) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Shortest signed turn from a to b. */
const turn = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/**
 * What the learner has made of you, set in type. The 18 feature words ring the
 * smoke like the lettering on a seal: liked words swell into warm italics,
 * disliked ones cool and get struck through, and the words you're hearing
 * shimmer while the smoke reaches out to them. Inside the ring, what's
 * audible now is set as a short poem that breathes with the music; vote and
 * its words lift off and fly out into the ring, where your taste is kept.
 */
export function TasteVerse({ source, ringFraction, lastVote, field, anchor, onPick }: TasteVerseProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceRef = useRef(source);
  const voteRef = useRef(lastVote);
  const fieldRef = useRef(field);
  const ringRef = useRef(ringFraction);
  const anchorRef = useRef(anchor);
  sourceRef.current = source;
  if (lastVote) voteRef.current = lastVote;
  fieldRef.current = field;
  ringRef.current = ringFraction;
  anchorRef.current = anchor;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = get2dContext(canvas);
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const ink = hexToRgb(css.getPropertyValue('--fg'), [236, 229, 216]);
    const warm = hexToRgb(css.getPropertyValue('--accent'), [240, 168, 96]);
    const cool = hexToRgb(css.getPropertyValue('--accent-cool'), [126, 200, 227]);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // Canvas draws with whatever font is loaded; ask for the serif so it arrives.
    void document.fonts?.load(`${REF_PX}px ${SERIF}`).catch(() => {});
    void document.fonts?.load(`italic ${REF_PX}px ${SERIF}`).catch(() => {});

    const rim: RimWord[] = GROUP_IDS.flatMap((group) =>
      FEATURE_GROUPS[group].map((id) => ({
        id, group, taste: 0, audible: 0, shownTaste: 0, shownAudible: 0, strike: 0, flashAt: -Infinity, flashSign: 0,
      })),
    );
    const byId = new Map(rim.map((w) => [w.id, w]));
    const poem = new Map<string, PoemWord>();
    let flights: Flight[] = [];
    const bands = new BandTracker();
    let level: Bands = { bass: 0, mid: 0, high: 0, beat: 0 };
    let primed = false;
    let lastPoll = -Infinity;
    let lastVoteAt = voteRef.current?.at ?? 0;
    let dpr = 1;
    /** Ring centre and radius in canvas px, from `anchor`; null = mid-canvas at `ringFraction`. */
    let centre: { x: number; y: number; r: number } | null = null;
    let raf = 0;
    let lastFrame = 0;
    /** The change on its way, as of the last poll. */
    let steering: ReturnType<NonNullable<TasteVerseProps['source']['getSteer']>> = null;
    /** A change that has landed: its poem holds until what's audible reads the same. */
    let arrived: ArrivedPoem | null = null;
    /** The ring as last drawn (CSS px), for picking words under the pointer. */
    let layout: { ring: { x: number; y: number; r: number }; places: RimPlace[] } | null = null;
    let hovered: string | null = null;

    // Advance widths per character at REF_PX, per style; kerning is ignored.
    const widths = new Map<string, number>();
    const advance = (ch: string, italic: boolean) => {
      const key = (italic ? 'i' : 'r') + ch;
      let w = widths.get(key);
      if (w === undefined) {
        ctx.font = `${italic ? 'italic ' : ''}${REF_PX}px ${SERIF}`;
        w = ctx.measureText(ch).width;
        // Cache only once the serif has arrived, so fallback metrics don't stick.
        if (document.fonts?.check?.(`${REF_PX}px ${SERIF}`) ?? true) widths.set(key, w);
      }
      return w;
    };
    const wordWidth = (text: string, size: number, italic: boolean, tracking: number) => {
      let w = 0;
      for (const ch of text) w += advance(ch, italic) * (size / REF_PX) + tracking * size;
      return w - tracking * size;
    };

    const poll = (now: number) => {
      const src = sourceRef.current;
      const taste = normalizeTaste(src.getTaste?.() ?? {});
      const audible = src.getAudibleFeatures?.() ?? {};
      const total = Object.values(audible).reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
      for (const word of rim) {
        const next = taste[word.id] ?? 0;
        // No flash for the first read; and a word that just landed from a flight has had its moment.
        if (primed && Math.abs(next - word.taste) > FLASH_DELTA && now - word.flashAt > FLASH_S) {
          word.flashAt = now;
          word.flashSign = Math.sign(next - word.taste);
        }
        word.taste = next;
        word.audible = total > 0 ? Math.max(0, audible[word.id] ?? 0) / total : 0;
      }
      primed = true;
      const live = src.getSteer?.() ?? null;
      arrived = advanceArrivedPoem(audible, live, steering, arrived, now);
      steering = live;
      const { lines, ink } = steeredPoem(audible, live ?? (arrived ? { progress: 1, to: arrived.to } : null));
      const keep = new Set(lines.map((l) => l.id));
      for (const entry of poem.values()) if (!keep.has(entry.id)) entry.target = 0;
      for (const line of lines) {
        const entry = poem.get(line.id);
        const inkTarget = ink.get(line.id) ?? 1;
        if (entry) {
          entry.targetShare = line.share;
          entry.target = 1;
          entry.inkTarget = inkTarget;
        } else {
          // An arriving word is there at once, as a ghost; its ink is what's still to come.
          const ghost = inkTarget < 1;
          poem.set(line.id, {
            id: line.id, share: line.share, targetShare: line.share, presence: ghost ? 1 : 0, target: 1,
            x: 0, y: NaN, size: 0, awayUntil: 0, ink: ghost ? inkTarget : 1, inkTarget,
          });
        }
      }
    };

    /** Letters of a word set along the circle, centred on `place.angle`. */
    const rimGlyphs = (text: string, place: RimPlace, size: number, italic: boolean, tracking: number, cx: number, cy: number, r: number): Glyph[] => {
      const total = wordWidth(text, size, italic, tracking);
      const dir = place.flip ? -1 : 1;
      let offset = -total / 2;
      const out: Glyph[] = [];
      for (const ch of text) {
        const w = advance(ch, italic) * (size / REF_PX);
        const a = place.angle + (dir * (offset + w / 2)) / r;
        out.push({ ch, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, rot: a + (dir * Math.PI) / 2, size });
        offset += w + tracking * size;
      }
      return out;
    };

    /** Letters of a word set flat, centred on (x, y). */
    const lineGlyphs = (text: string, x: number, y: number, size: number, italic: boolean, tracking: number): Glyph[] => {
      const total = wordWidth(text, size, italic, tracking);
      let offset = -total / 2;
      const out: Glyph[] = [];
      for (const ch of text) {
        const w = advance(ch, italic) * (size / REF_PX);
        out.push({ ch, x: x + offset + w / 2, y, rot: 0, size });
        offset += w + tracking * size;
      }
      return out;
    };

    const drawGlyph = (g: Glyph) => {
      const s = (g.size / REF_PX) * dpr;
      const c = Math.cos(g.rot) * s;
      const n = Math.sin(g.rot) * s;
      ctx.setTransform(c, n, -n, c, g.x * dpr, g.y * dpr);
      ctx.fillText(g.ch, 0, 0);
    };

    /** A glyph's outline, `width` css px thick whatever its size. */
    const strokeGlyph = (g: Glyph, width: number) => {
      const s = (g.size / REF_PX) * dpr;
      const c = Math.cos(g.rot) * s;
      const n = Math.sin(g.rot) * s;
      ctx.setTransform(c, n, -n, c, g.x * dpr, g.y * dpr);
      ctx.lineWidth = (width * REF_PX) / g.size;
      ctx.strokeText(g.ch, 0, 0);
    };

    const setFont = (italic: boolean) => {
      ctx.font = `${italic ? 'italic ' : ''}${REF_PX}px ${SERIF}`;
    };

    const draw = (now: number, dt: number) => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      const cx = centre?.x ?? w / 2;
      const cy = centre?.y ?? h / 2;
      const r = Math.min((h / 2) * RIM_FRACTION, w * 0.45, cy - 30);
      // The poem keeps inside the ring; on narrow screens the ring keeps inside the lettering.
      const ringPx = Math.min(centre?.r ?? (h / 2) * ringRef.current, r * RING_IN_RIM);
      const k = reduced ? 1 : 1 - Math.exp(-dt / 0.45); // ease displayed values toward the latest read
      const motion = reduced ? 0 : 1;

      // ---- the ring of words ----
      const styles = rim.map((word) => {
        word.shownTaste += (word.taste - word.shownTaste) * k;
        word.shownAudible += (word.audible - word.shownAudible) * k;
        word.strike += ((word.shownTaste < -0.12 ? 1 : 0) - word.strike) * (reduced ? 1 : 1 - Math.exp(-dt / 0.6));
        const like = Math.max(0, word.shownTaste);
        const dislike = Math.max(0, -word.shownTaste);
        const age = now - word.flashAt;
        const flash = age >= 0 && age < FLASH_S ? Math.pow(1 - age / FLASH_S, 2) : 0;
        const italic = like > 0.12;
        // A word under the pointer lifts slightly: tapping it leans the music its way.
        const size = RIM_SIZE + RIM_GROW * like + 5 * flash * motion + (hovered === word.id ? 3 : 0);
        // Disliked words come loose: their letters drift apart under the strike.
        const tracking = italic ? 0.01 : 0.06 + 0.14 * dislike;
        return { word, like, dislike, flash, italic, size, tracking, width: wordWidth(word.id, size, italic, tracking) };
      });
      const { places, scale } = layoutRim(
        styles.map((s) => ({ id: s.word.id, group: s.word.group, width: s.width })),
        r,
        { gap: GAP_RADIANS, wordSpace: 18, groupSpace: 46 },
      );
      layout = { ring: { x: cx, y: cy, r }, places };
      const placeOf = new Map(places.map((p) => [p.id, p]));
      const glyphsOf = new Map<string, Glyph[]>();

      const shared = fieldRef.current;
      if (shared) {
        shared.rim = r / (h / 2);
        shared.words = styles.map((s, i) => ({ angle: places[i]!.angle, audible: s.word.shownAudible, taste: s.word.shownTaste }));
      }

      styles.forEach((s, i) => {
        const place = places[i]!;
        const glyphs = rimGlyphs(s.word.id, place, s.size * scale, s.italic, s.tracking, cx, cy, r);
        glyphsOf.set(s.word.id, glyphs);
        const heard = clamp01(s.word.shownAudible * 2.2);
        let color = mix(ink, warm, clamp01(s.like * 1.5));
        color = mix(color, cool, clamp01(s.dislike * 1.3));
        if (s.flash > 0) color = mix(color, s.word.flashSign >= 0 ? warm : cool, s.flash);
        const hover = hovered === s.word.id ? 1 : 0;
        const base = Math.min(1, 0.3 + 0.62 * Math.max(s.like, s.dislike * 0.6) + 0.3 * heard + 0.5 * s.flash + 0.45 * hover);
        setFont(s.italic);
        // Heard words burn nearly white, whatever you think of them.
        ctx.fillStyle = rgb(mix(color, [255, 248, 236], heard * 0.7));
        if (heard > 0.05) {
          ctx.shadowColor = rgb(mix(ink, warm, clamp01(s.like)));
          ctx.shadowBlur = 14 * heard * dpr;
        }
        glyphs.forEach((g, j) => {
          // While heard, a slow light runs along the letters and they lift with the bass.
          const wave = 0.5 + 0.5 * Math.sin(now * 2.6 - j * 0.7 + i);
          const lift = motion * heard * (1.5 + 3 * level.bass) * wave;
          const ga = Math.atan2(g.y - cy, g.x - cx);
          ctx.globalAlpha = Math.min(1, base * (1 - heard * 0.35 + heard * 0.6 * (motion ? wave : 1)));
          drawGlyph({ ...g, x: g.x + Math.cos(ga) * lift, y: g.y + Math.sin(ga) * lift });
        });
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
        // Disliked: a hairline struck through along the arc, drawn in as the score sinks.
        if (s.word.strike > 0.01) {
          const first = glyphs[0]!;
          const last = glyphs.at(-1)!;
          const a0 = Math.atan2(first.y - cy, first.x - cx);
          const a1 = Math.atan2(last.y - cy, last.x - cx);
          const pad = (s.size * scale * 0.35) / r;
          const from = a0 - (place.flip ? -pad : pad);
          const span = turn(from, a1 + (place.flip ? -pad : pad));
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.globalAlpha = 0.5 * Math.max(0.5, s.dislike) * s.word.strike;
          ctx.strokeStyle = rgb(cool);
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.arc(cx, cy, r, from, from + span * s.word.strike, span < 0);
          ctx.stroke();
        }
      });

      // Group breaks get a small ornament, like a type specimen.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = rgb(ink);
      ctx.globalAlpha = 0.28;
      for (let i = 1; i < places.length; i++) {
        if (rim[i]!.group === rim[i - 1]!.group) continue;
        const a = (places[i - 1]!.angle + places[i]!.angle) / 2;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- the poem: what's audible now, inside the ring ----
      const lines = [...poem.values()].filter((p) => p.target > 0 || p.presence > 0.01);
      for (const p of poem.values()) if (p.target === 0 && p.presence <= 0.01) poem.delete(p.id);
      const maxShare = Math.max(0.01, ...lines.filter((p) => p.target > 0).map((p) => p.targetShare));
      const natural = lines.map((p) => {
        p.share += (p.targetShare - p.share) * k;
        return 18 + 26 * clamp01(p.share / maxShare);
      });
      // Shrink the whole poem to fit the eye of the ring: height and the widest line.
      const tall = natural.reduce((sum, v) => sum + v * 1.02, 0);
      const wide = Math.max(1, ...lines.map((p, i) => wordWidth(p.id, natural[i]!, true, 0.02) + natural[i]! * 0.9));
      const fit = Math.min(1.1, (ringPx * 1.05) / Math.max(tall, 1), (ringPx * 1.25) / wide);
      const sizes = natural.map((v) => v * fit);
      // Leaving words give up their line as they fade, so the rest close up smoothly.
      const shown = lines.map((p, i) => sizes[i]! * 1.02 * (p.target > 0 ? 1 : clamp01(p.presence * 1.5)));
      let y = cy - shown.reduce((sum, v) => sum + v, 0) / 2;
      const breath = 1 + motion * (0.035 * level.bass + 0.02 * level.beat);
      lines.forEach((p, i) => {
        const size = sizes[i]! * breath;
        const target = y + shown[i]! / 2;
        y += shown[i]!;
        p.y = Number.isNaN(p.y) || reduced ? target : p.y + (target - p.y) * (1 - Math.exp(-dt / 0.35));
        const want = now < p.awayUntil ? 0 : p.target;
        p.presence += (want - p.presence) * (reduced ? 1 : 1 - Math.exp(-dt / (want > 0 ? 0.9 : 0.5)));
        p.ink += (p.inkTarget - p.ink) * (reduced ? 1 : 1 - Math.exp(-dt / 0.3));
        const word = byId.get(p.id);
        const taste = word?.shownTaste ?? 0;
        let color = mix(ink, warm, clamp01(taste) * 0.75);
        color = mix(color, cool, clamp01(-taste) * 0.6);
        // Alternate lines step left and right, set like verse.
        const indent = i === 0 ? 0 : (i % 2 ? 1 : -1) * size * 0.45;
        const tracking = 0.02 + motion * 0.05 * level.mid;
        p.x = cx + indent;
        p.size = size;
        const glyphs = lineGlyphs(p.id, p.x, p.y, size, true, tracking);
        setFont(true);
        // Ink that is still arriving (or leaving) carries the colour of what set it moving.
        const inking = p.ink < 0.995;
        const tint = !steering || steering.vote === null ? mix(ink, warm, 0.45) : steering.vote === 'up' ? warm : cool;
        const n = glyphs.length;
        glyphs.forEach((g, j) => {
          // Letters arrive (and leave) one after another, rising out of the smoke.
          const a = reduced ? p.presence : clamp01(p.presence * (n + 3) - j);
          if (a <= 0.01) return;
          const at = { ...g, y: g.y + (1 - a) * 8 * motion };
          // Ink runs through the word letter by letter; the rest waits as a hairline.
          const inked = inking ? clamp01(p.ink * n - j) : 1;
          if (inked < 1) {
            ctx.strokeStyle = rgb(mix(color, tint, 0.5));
            ctx.globalAlpha = a * 0.42 * (1 - inked);
            strokeGlyph(at, 0.9);
          }
          if (inked > 0.01) {
            ctx.fillStyle = rgb(inking ? mix(color, tint, 0.55 * (1 - p.ink)) : color);
            ctx.globalAlpha = a * 0.94 * inked;
            drawGlyph(at);
          }
        });
      });

      // ---- votes: the words you were hearing fly out into the ring ----
      flights = flights.filter((f) => now - f.start < FLIGHT_S + f.from.length * LETTER_DELAY_S);
      for (const f of flights) {
        const to = glyphsOf.get(f.id);
        const place = placeOf.get(f.id);
        if (!to || !place) continue;
        const style = styles.find((s) => s.word.id === f.id)!;
        setFont(f.italic);
        ctx.fillStyle = rgb(f.sign > 0 ? warm : cool);
        ctx.shadowColor = rgb(f.sign > 0 ? warm : cool);
        ctx.shadowBlur = 12 * dpr;
        f.from.forEach((g, j) => {
          const t = clamp01((now - f.start - j * LETTER_DELAY_S) / FLIGHT_S);
          if (t <= 0 || t >= 1) return;
          const e = easeInOut(t);
          const dest = to[Math.min(j, to.length - 1)]!;
          // Spiral out: swing round the centre a little on the way.
          const fx = g.x - cx;
          const fy = g.y - cy;
          const tx = dest.x - cx;
          const ty = dest.y - cy;
          const r0 = Math.hypot(fx, fy);
          const r1 = Math.hypot(tx, ty);
          const a0 = Math.atan2(fy, fx);
          const a1 = Math.atan2(ty, tx);
          // A like swings clockwise on the way out, a dislike against the grain.
          const ang = a0 + turn(a0, a1) * e + f.sign * 0.5 * Math.sin(Math.PI * e);
          const rr = r0 + (r1 - r0) * e;
          ctx.globalAlpha = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.95;
          drawGlyph({
            ch: g.ch,
            x: cx + Math.cos(ang) * rr,
            y: cy + Math.sin(ang) * rr,
            rot: g.rot + turn(g.rot, dest.rot) * e,
            size: g.size + (style.size * scale - g.size) * e,
          });
        });
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    /** A vote: every word of the poem lifts off toward its place in the ring. */
    const launch = (now: number, v: Vote) => {
      if (reduced) return;
      // Words still writing themselves in step aside too, so the eye of the ring clears.
      for (const p of poem.values()) {
        if (p.presence > 0.4) continue;
        p.presence = 0;
        p.awayUntil = now + FLIGHT_S;
      }
      const lines = [...poem.values()].filter((p) => p.target > 0 && p.presence > 0.4);
      lines.forEach((p, i) => {
        const start = now + i * 0.12;
        flights.push({ id: p.id, start, sign: v === 'up' ? 1 : -1, italic: true, from: lineGlyphs(p.id, p.x, p.y, p.size, true, 0.02) });
        // The word leaves the poem, then writes itself back in once it has landed.
        p.presence = 0;
        p.awayUntil = start + FLIGHT_S + 0.3;
        const word = byId.get(p.id);
        if (word) {
          word.flashAt = start + FLIGHT_S * 0.85;
          word.flashSign = v === 'up' ? 1 : -1;
        }
      });
    };

    const loop = (nowMs: number) => {
      raf = requestAnimationFrame(loop);
      if (nowMs - lastFrame < 30) return; // ~30 fps is plenty for this layer
      const dt = Math.min((nowMs - lastFrame) / 1000, 0.1);
      lastFrame = nowMs;
      const now = nowMs / 1000;
      if (nowMs - lastPoll > POLL_MS) {
        lastPoll = nowMs;
        poll(now);
        const box = anchorRef.current?.();
        const own = box ? canvas.getBoundingClientRect() : null;
        centre = box && own && box.width > 0
          ? { x: box.left + box.width / 2 - own.left, y: box.top + box.height / 2 - own.top, r: Math.min(box.width, box.height) * 0.33 }
          : null;
      }
      const vote = voteRef.current;
      if (vote && vote.at !== lastVoteAt) {
        lastVoteAt = vote.at;
        launch(now, vote.v);
      }
      if (!reduced) level = bands.update(sourceRef.current.getAnalyser?.() ?? null, dt, now);
      draw(now, dt);
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

    // The canvas lets taps through to the controls; the ring picks from window events instead.
    const pick = (e: PointerEvent | MouseEvent): string | null => {
      if (!pickRef.current || !layout) return null;
      if (e.target instanceof Element && e.target.closest(OWN_CLICKS)) return null;
      const own = canvas.getBoundingClientRect();
      return pickRimWord(layout.places, layout.ring, e.clientX - own.left, e.clientY - own.top, PICK_BAND);
    };
    const onMove = (e: PointerEvent) => {
      const id = e.pointerType === 'mouse' ? pick(e) : null;
      if (id === hovered) return;
      hovered = id;
      document.body.style.cursor = id ? 'pointer' : '';
    };
    const onClick = (e: MouseEvent) => {
      const id = pick(e);
      if (!id) return;
      const word = byId.get(id);
      if (word) {
        word.flashAt = performance.now() / 1000;
        word.flashSign = 1;
      }
      pickRef.current?.(id);
    };

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('click', onClick);
    resize();
    sync();
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('click', onClick);
      document.body.style.cursor = '';
    };
  }, []);

  return <canvas ref={canvasRef} className="taste-verse" aria-hidden="true" />;
}
