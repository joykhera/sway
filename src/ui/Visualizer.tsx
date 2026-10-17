import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, Lightformer, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';
import type {
  MusicSessionController,
  MusicSignature,
  StreamLevels,
  Vote,
} from './contracts.ts';

export type VisualizerProps = {
  /** Session controller — stats (~10 Hz) and signature feed the organism. Optional: without it the blob breathes on ambient drift alone. */
  controller?: MusicSessionController;
  /** Session view is live; idle rests the blob dimmer and calmer. */
  active: boolean;
  /** The latest thumbs vote — a whole-body jelly wobble (never one-sided). */
  lastVote?: { v: Vote; at: number } | null;
};

/* ------------------------------------------------------------------ *
 * The organism is a real displaced mesh now (three.js via R3F):
 * an icosphere whose vertices are noise-displaced (MeshDistortMaterial)
 * under a thin-film iridescent physical material, lit by a procedural
 * Lightformer environment. Satellites: two small glossy orbs.
 * ------------------------------------------------------------------ */

export const BLOB_POINTS = 8; // retained for tests; the mesh itself is a high-res icosphere
const MAX_DPR = 1.75;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Deterministic 0..1 hash — the same signature always grows the same blob. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * Morphable anatomy. `current` eases toward `target` every frame; a signature
 * change rewrites `target` only, so steering is felt but never snaps.
 */
export type BlobParams = {
  /** Warm↔cool shift applied to the iridescence thickness (nm). */
  hueBias: number;
  /** Resting vertex-noise amount (amorphousness). */
  distort: number;
  /** Noise evolution speed (internal swirl tempo). */
  speed: number;
  /** Surface roughness — calm is softer, hype is glossier. */
  roughness: number;
  /** Drift amplitude multiplier. */
  drift: number;
};

export const BASE_PARAMS: BlobParams = {
  hueBias: 0,
  distort: 0.34,
  speed: 1.6,
  roughness: 0.22,
  drift: 1,
};

/** Map a MusicSignature to a target anatomy — hash for spread, keywords for intent. */
export function paramsForSignature(sig: MusicSignature | undefined): BlobParams {
  const text = [sig?.genre, sig?.instrument, sig?.mood, sig?.texture, sig?.focus]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return { ...BASE_PARAMS };
  const h = (salt: string) => hash01(`${text}·${salt}`);
  const p: BlobParams = {
    hueBias: (h('hue') - 0.5) * 120,
    distort: 0.24 + h('dist') * 0.28,
    speed: 1.1 + h('speed') * 1.4,
    roughness: 0.16 + h('rough') * 0.2,
    drift: 0.7 + h('drift') * 0.7,
  };
  if (/calm|ambient|soft|gentle|sparse|minimal|slow/.test(text)) {
    p.distort -= 0.08;
    p.speed *= 0.7;
    p.drift *= 0.7;
    p.roughness += 0.08;
  }
  if (/energetic|driving|aggressive|intense|dense|hype|fast|techno/.test(text)) {
    p.distort += 0.1;
    p.speed *= 1.35;
    p.roughness -= 0.06;
  }
  if (/warm|golden|amber|sun|jazz|soul|analog/.test(text)) p.hueBias -= 90;
  if (/cool|cold|ice|blue|night|techno|electro|digital/.test(text)) p.hueBias += 90;
  p.hueBias = clamp(p.hueBias, -160, 160);
  p.distort = clamp(p.distort, 0.12, 0.6);
  p.speed = clamp(p.speed, 0.6, 3.4);
  p.roughness = clamp(p.roughness, 0.08, 0.5);
  p.drift = clamp(p.drift, 0.3, 1.6);
  return p;
}

/** Everything the subscriptions collect — read by useFrame, never by render. */
type DataPlane = {
  levels: StreamLevels | null;
  energy: number; // smoothed
  brightnessNorm: number;
  pitchHue: number; // smoothed hue shift (nm of film thickness)
  genPrev: number;
  ripple: number; // generation impulse
  wobble: number; // vote impulse 0..1
  wobbleWarm: number; // +1 up / -1 down, decays
  params: { cur: BlobParams; tgt: BlobParams };
  sigSeen: boolean;
  active: boolean;
  reduced: boolean;
};

function useDataPlane(
  controller: MusicSessionController | undefined,
  active: boolean,
  lastVote: { v: Vote; at: number } | null,
  reduced: boolean,
): React.MutableRefObject<DataPlane> {
  const data = useRef<DataPlane>({
    levels: null,
    energy: 0,
    brightnessNorm: 0,
    pitchHue: 0,
    genPrev: 0,
    ripple: 0,
    wobble: 0,
    wobbleWarm: 0,
    params: { cur: { ...BASE_PARAMS }, tgt: { ...BASE_PARAMS } },
    sigSeen: false,
    active,
    reduced,
  });

  useEffect(() => {
    data.current.active = active;
  }, [active]);
  useEffect(() => {
    data.current.reduced = reduced;
  }, [reduced]);

  useEffect(() => {
    if (!lastVote) return;
    data.current.wobble = 1;
    data.current.wobbleWarm = lastVote.v === 'up' ? 1 : -1;
  }, [lastVote]);

  useEffect(() => {
    if (!controller) return;
    data.current.sigSeen = false;
    const offState = controller.subscribe?.((state) => {
      const next = paramsForSignature(state.signature);
      if (!data.current.sigSeen) {
        data.current.sigSeen = true;
        data.current.params.cur = next; // first emit snaps — no morph away from defaults
      }
      data.current.params.tgt = next;
    });
    const offStats = controller.subscribeStats?.((levels) => {
      const d = data.current;
      if (levels.generation > d.genPrev && d.genPrev > 0) {
        d.ripple = Math.min(1, d.ripple + 0.55); // a new block landed — outline shivers
      }
      d.genPrev = Math.max(d.genPrev, levels.generation);
      d.levels = levels;
      d.energy = lerp(d.energy, clamp(levels.energy, 0, 1), 0.3);
      d.brightnessNorm = lerp(d.brightnessNorm, clamp(levels.brightnessHz / 4000, 0, 1), 0.2);
      const pitchT = levels.pitchHz && levels.pitchHz > 20
        ? clamp(Math.log2(levels.pitchHz / 55) / 4, 0, 1)
        : 0.5;
      d.pitchHue = lerp(d.pitchHue, (pitchT - 0.5) * 260, 0.15);
    });
    return () => {
      offState?.();
      offStats?.();
      data.current.levels = null;
      data.current.genPrev = 0;
    };
  }, [controller]);

  return data;
}

/* ---------------------------- the blob ---------------------------- */

function Blob({ data }: { data: React.MutableRefObject<DataPlane> }) {
  const group = useRef<THREE.Group>(null);
  const mat = useRef<any>(null);
  const leftOrb = useRef<THREE.Mesh>(null);
  const rightOrb = useRef<THREE.Mesh>(null);
  const keyA = useRef<THREE.PointLight>(null);
  const keyB = useRef<THREE.PointLight>(null);

  useFrame((state, delta) => {
    const d = data.current;
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    const calm = d.reduced ? 0.12 : 1;

    // ease params toward target (~2 s settle)
    const k = 1 - Math.exp(-dt / 0.65);
    const cur = d.params.cur;
    const tgt = d.params.tgt;
    for (const key of Object.keys(cur) as (keyof BlobParams)[]) {
      (cur as Record<keyof BlobParams, number>)[key] = lerp(cur[key], tgt[key], k);
    }
    d.ripple = Math.max(0, d.ripple - dt * 1.6);
    d.wobble = Math.max(0, d.wobble - dt * 0.9);
    d.wobbleWarm = lerp(d.wobbleWarm, 0, 1 - Math.exp(-dt / 0.8));

    const g = group.current;
    const m = mat.current;
    if (!g || !m) return;

    const energy = d.energy * (d.active ? 1 : 0.45);
    const wobble = d.wobble * d.wobble; // sharper attack, soft release
    const swell = 1 + energy * 0.16 + wobble * (d.wobbleWarm > 0 ? 0.1 : -0.07) + d.ripple * 0.05;

    // amorphousness: resting distort + energy + vote jelly + generation ripple
    m.distort = clamp(cur.distort * (d.active ? 1 : 0.7) + energy * 0.16 + wobble * 0.2 + d.ripple * 0.12, 0.08, 0.75);
    m.speed = cur.speed * calm * (0.7 + d.brightnessNorm * 0.9); // brightness stirs the swirl
    m.roughness = clamp(cur.roughness - energy * 0.06, 0.06, 0.5);

    // pitch + signature steer the thin-film hue; votes nudge it warm/cool
    const thickness = clamp(380 + cur.hueBias + d.pitchHue + d.wobbleWarm * d.wobble * 140, 120, 900);
    m.iridescenceThicknessRange = [Math.max(60, thickness - 260), Math.min(1400, thickness + 260)];

    // swell + slow tumble + lissajous drift (kept clear of corner panels)
    const drift = cur.drift * calm;
    g.scale.setScalar(lerp(g.scale.x || 1, swell, 1 - Math.exp(-dt / 0.25)));
    g.rotation.y += dt * 0.08 * calm * (0.6 + d.brightnessNorm);
    g.rotation.x = Math.sin(t * 0.19) * 0.12 * calm;
    g.rotation.z = Math.cos(t * 0.13) * 0.09 * calm;
    g.position.x = Math.sin(t * 0.3) * 0.28 * drift + Math.sin(t * 0.043) * 0.1 * drift;
    g.position.y = Math.cos(t * 0.21) * 0.18 * drift + Math.sin(t * 0.029 + 1.3) * 0.08 * drift;

    // interior light churn — the two keys orbit so bands swim through the glass
    if (keyA.current && keyB.current) {
      const r = 2.6 + energy * 0.8;
      keyA.current.position.set(Math.cos(t * 0.34 * calm) * r, Math.sin(t * 0.27) * 1.2, Math.sin(t * 0.34) * r);
      keyB.current.position.set(Math.cos(-t * 0.23 * calm + 2.4) * r, Math.cos(t * 0.31) * 1.1, Math.sin(-t * 0.23 + 2.4) * r);
      const glow = (d.active ? 2.4 : 1.1) * (0.75 + energy * 0.5 + wobble * 0.6);
      keyA.current.intensity = glow;
      keyB.current.intensity = glow * 0.8;
      keyA.current.color.setHSL((((240 + cur.hueBias + d.pitchHue) % 360) + 360) % 360 / 360, 0.75, 0.6);
      keyB.current.color.setHSL((((300 + cur.hueBias * 0.6 + d.pitchHue * 0.7) % 360) + 360) % 360 / 360, 0.8, 0.55);
    }

    // satellites: lazy counter-orbits
    const a1 = t * 0.21 * calm + 2.1;
    const a2 = -t * 0.17 * calm - 0.6;
    if (leftOrb.current) {
      leftOrb.current.position.set(-2.15 + Math.sin(a1) * 0.16, Math.cos(a1 * 0.8) * 0.22, Math.sin(a1 * 0.6) * 0.4);
      leftOrb.current.scale.setScalar(0.14 + energy * 0.03 + wobble * 0.02);
    }
    if (rightOrb.current) {
      rightOrb.current.position.set(2.05 + Math.sin(a2) * 0.18, Math.cos(a2 * 0.7 + 1) * 0.24, Math.cos(a2 * 0.5) * 0.35);
      rightOrb.current.scale.setScalar(0.1 + energy * 0.02 + wobble * 0.015);
    }
  });

  return (
    <>
      {/* orbiting interior lights — the iridescent bands that swim inside */}
      <pointLight ref={keyA} intensity={2} distance={9} decay={1.6} />
      <pointLight ref={keyB} intensity={1.6} distance={9} decay={1.6} />
      <ambientLight intensity={0.12} />

      <group ref={group}>
        <mesh>
          <icosahedronGeometry args={[1.05, 96]} />
          <MeshDistortMaterial
            ref={mat}
            color="#14101f"
            metalness={0.5}
            roughness={0.22}
            clearcoat={1}
            clearcoatRoughness={0.18}
            iridescence={1}
            iridescenceIOR={1.34}
            envMapIntensity={1.6}
            distort={0.34}
            speed={1.6}
          />
        </mesh>
      </group>

      <mesh ref={leftOrb} scale={0.14} position={[-2.15, 0, 0]}>
        <sphereGeometry args={[1, 48, 48]} />
        <meshPhysicalMaterial
          color="#1a1226"
          metalness={0.35}
          roughness={0.12}
          clearcoat={1}
          iridescence={0.9}
          iridescenceIOR={1.32}
          envMapIntensity={1.4}
        />
      </mesh>
      <mesh ref={rightOrb} scale={0.1} position={[2.05, 0, 0]}>
        <sphereGeometry args={[1, 48, 48]} />
        <meshPhysicalMaterial
          color="#1a1226"
          metalness={0.35}
          roughness={0.12}
          clearcoat={1}
          iridescence={0.9}
          iridescenceIOR={1.32}
          envMapIntensity={1.4}
        />
      </mesh>
    </>
  );
}

/* ------------------------------ stage ------------------------------ */

function useReducedMotion(): boolean {
  const ref = useRef(
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => (ref.current = mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return ref.current;
}

/** WebGL isn't guaranteed (jsdom, disabled GPU) — probe once, fall back to a calm void. */
function webglAvailable(): boolean {
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * The organism: a floating liquid-glass blob rendered in real 3D — a
 * noise-displaced icosphere in a thin-film iridescent physical material,
 * two glossy satellite orbs, procedural reflections. Energy swells it,
 * brightness stirs the internal swirl, pitch slides the film hue,
 * generation ripples the outline, votes wobble the whole body.
 */
export function Visualizer({ controller, active, lastVote = null }: VisualizerProps) {
  const reduced = useReducedMotion();
  const data = useDataPlane(controller, active, lastVote, reduced);
  const ok = useMemo(webglAvailable, []);
  if (!ok) {
    return <div className="visualizer" aria-hidden="true" />;
  }
  return (
    <div className="visualizer" aria-hidden="true">
      <Canvas
        dpr={[1, MAX_DPR]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ position: [0, 0, 5.4], fov: 42 }}
      >
        <Blob data={data} />
        {/* procedural env map — no external HDR fetch; colored streaks = film bands */}
        <Environment resolution={256}>
          <Lightformer intensity={1.6} position={[0, 2.4, 2]} scale={[7, 1.1, 1]} color="#b987ff" />
          <Lightformer intensity={1.2} position={[-3, -1, -1]} rotation-y={Math.PI / 2.4} scale={[5, 0.8, 1]} color="#54d0ff" />
          <Lightformer intensity={1.4} position={[3, 1.4, -2]} rotation-y={-Math.PI / 3} scale={[6, 0.9, 1]} color="#ff5fa8" />
          <Lightformer intensity={0.7} position={[0, -3, 1]} scale={[8, 1.4, 1]} color="#2834ff" />
        </Environment>
      </Canvas>
    </div>
  );
}
