// WebGL2 engine for the flow visualizer: GPU particles in a curl-noise field
// with feedback trails. Framework-free; Visualizer.tsx owns the loop and inputs.
import type { Bands } from './audio-bands.ts';
import type { Look, Rgb } from './looks.ts';
import { MAX_FIELD_WORDS, packField, RING_IN_RIM, type TasteField } from './verse.ts';
import { DISPLAY_FS, FADE_FS, FULLSCREEN_VS, POINTS_FS, POINTS_VS, SIM_FS } from './shaders.ts';

export type FlowFrame = {
  /** Seconds since start, and since the last frame. */
  time: number;
  dt: number;
  bands: Bands;
  look: Look;
  /** Decaying 0..1 vote pulses. */
  up: number;
  down: number;
  /** False before playback: the piece dims and slows. */
  active: boolean;
  warm: Rgb;
  cool: Rgb;
  /** Taste lettering around the ring, if any. */
  field?: TasteField;
};

export interface FlowRenderer {
  /** Backing-store size in device pixels, and the device-pixel ratio used for point sizes. */
  resize(width: number, height: number, dpr: number): void;
  render(frame: FlowFrame): void;
  dispose(): void;
}

const RING_RADIUS = 0.42;

/** True when this browser can run the flow visualizer (WebGL2 + float render targets). */
export function supportsFlowRenderer(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ok = !!gl && !!gl.getExtension('EXT_color_buffer_float');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

type Program = { program: WebGLProgram; uniform(name: string): WebGLUniformLocation | null };
type Target = { texture: WebGLTexture; fbo: WebGLFramebuffer };

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    uniform(name) {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
      return cache.get(name)!;
    },
  };
}

function target(gl: WebGL2RenderingContext, width: number, height: number, format: 'state' | 'trail', data: Float32Array | null = null): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const filter = format === 'state' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (format === 'state') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.clearColor(0, 0, 0, 1);
  if (format === 'trail') gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, fbo };
}

function seedParticles(side: number): Float32Array {
  const data = new Float32Array(side * side * 4);
  for (let i = 0; i < side * side; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = RING_RADIUS * (1 + (Math.random() - 0.5) * 0.4);
    data[i * 4] = r * Math.cos(a);
    data[i * 4 + 1] = r * Math.sin(a);
    data[i * 4 + 2] = Math.random(); // staggered lives so rebirths don't pulse in sync
    data[i * 4 + 3] = Math.random();
  }
  return data;
}

/**
 * Returns null when WebGL2 or float render targets are unavailable.
 * `side` × `side` particles (default 256 → 65,536).
 */
export function createFlowRenderer(canvas: HTMLCanvasElement, opts: { side?: number; onContextLost?: () => void } = {}): FlowRenderer | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;

  const side = opts.side ?? 256;
  const count = side * side;
  let sim: Program, fade: Program, points: Program, display: Program;
  try {
    sim = compile(gl, FULLSCREEN_VS, SIM_FS);
    fade = compile(gl, FULLSCREEN_VS, FADE_FS);
    points = compile(gl, POINTS_VS, POINTS_FS);
    display = compile(gl, FULLSCREEN_VS, DISPLAY_FS);
  } catch (err) {
    console.warn('[sway] flow visualizer unavailable:', err);
    return null;
  }

  const initial = seedParticles(side);
  const state = [target(gl, side, side, 'state', initial), target(gl, side, side, 'state', initial)];
  let trails: Target[] = [];
  let current = 0;
  let trailCurrent = 0;
  let width = 1;
  let height = 1;
  let dpr = 1;
  let disposed = false;
  const words = new Float32Array(MAX_FIELD_WORDS * 4);

  const onLost = (event: Event) => {
    event.preventDefault();
    opts.onContextLost?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  const freeTrails = () => {
    for (const t of trails) {
      gl.deleteTexture(t.texture);
      gl.deleteFramebuffer(t.fbo);
    }
    trails = [];
  };

  const bindTexture = (p: Program, name: string, texture: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(p.uniform(name), 0);
  };

  return {
    resize(w, h, ratio) {
      if (disposed || (w === width && h === height && trails.length)) return;
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      dpr = ratio;
      canvas.width = width;
      canvas.height = height;
      freeTrails();
      trails = [target(gl, width, height, 'trail'), target(gl, width, height, 'trail')];
    },

    render(frame) {
      if (disposed || gl.isContextLost() || !trails.length) return;
      const { look, bands } = frame;
      const dt = Math.min(Math.max(frame.dt, 0), 0.05);
      const aspect = width / height;
      const pace = frame.active ? 1 : 0.35;
      const wordCount = frame.field ? packField(frame.field, words) : 0;
      // On narrow screens the lettering comes in from the sides; keep the ring inside it.
      const rim = frame.field?.rim ?? 0;
      const ring = rim > 0 ? Math.min(RING_RADIUS, rim * RING_IN_RIM) : RING_RADIUS;

      // 1. Simulate.
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, state[1 - current]!.fbo);
      gl.viewport(0, 0, side, side);
      gl.useProgram(sim.program);
      bindTexture(sim, 'uState', state[current]!.texture);
      const f = (name: string, value: number) => gl.uniform1f(sim.uniform(name), value);
      f('uTime', frame.time);
      f('uDt', dt * pace);
      f('uRadius', ring);
      f('uSpread', look.spread);
      f('uSwirl', look.swirl);
      f('uTurb', look.turbulence);
      f('uNoiseScale', look.noiseScale);
      f('uFlow', look.flow);
      f('uSpeed', look.speed);
      f('uPull', look.pull);
      f('uBurst', look.burst);
      f('uBass', bands.bass);
      f('uMid', bands.mid);
      f('uBeat', bands.beat);
      f('uUp', frame.up);
      f('uDown', frame.down);
      gl.uniform4fv(sim.uniform('uWords'), words);
      gl.uniform1i(sim.uniform('uWordCount'), wordCount);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      current = 1 - current;

      // 2. Fade and drift the previous trails into the other buffer.
      const prev = trails[trailCurrent]!;
      const next = trails[1 - trailCurrent]!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo);
      gl.viewport(0, 0, width, height);
      gl.useProgram(fade.program);
      bindTexture(fade, 'uPrev', prev.texture);
      gl.uniform2f(fade.uniform('uRes'), width, height);
      gl.uniform1f(fade.uniform('uAspect'), aspect);
      gl.uniform1f(fade.uniform('uFade'), Math.pow(Math.min(look.trail, 0.95), dt));
      gl.uniform1f(fade.uniform('uZoom'), look.drift * 0.6 * dt * pace * (1 + bands.beat));
      gl.uniform1f(fade.uniform('uRot'), look.spin * dt * pace);
      gl.uniform1f(fade.uniform('uTime'), frame.time);
      gl.uniform1f(fade.uniform('uWarp'), 0.03 * dt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 3. Particles, additively.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(points.program);
      bindTexture(points, 'uState', state[current]!.texture);
      gl.uniform1i(points.uniform('uSide'), side);
      gl.uniform1f(points.uniform('uAspect'), aspect);
      gl.uniform1f(points.uniform('uPointSize'), look.grain * dpr);
      gl.uniform1f(points.uniform('uHigh'), bands.high);
      gl.uniform1f(points.uniform('uTime'), frame.time);
      gl.uniform1f(points.uniform('uUp'), frame.up);
      gl.uniform1f(points.uniform('uDown'), frame.down);
      // Brightness per particle, normalized so a 30 s trail and a 5 s trail read alike.
      const persistence = 1 / Math.max(1 - Math.pow(Math.min(look.trail, 0.95), 1 / 60), 1e-3);
      gl.uniform1f(points.uniform('uDensity'), (look.density * 1.5 * (frame.active ? 1 : 0.5)) / persistence * (65536 / count));
      gl.uniform3fv(points.uniform('uColorA'), look.colorA);
      gl.uniform3fv(points.uniform('uColorB'), look.colorB);
      gl.uniform3fv(points.uniform('uHighlight'), look.highlight);
      gl.uniform3fv(points.uniform('uWarm'), frame.warm);
      gl.uniform3fv(points.uniform('uCool'), frame.cool);
      gl.uniform4fv(points.uniform('uWords'), words);
      gl.uniform1i(points.uniform('uWordCount'), wordCount);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disable(gl.BLEND);
      trailCurrent = 1 - trailCurrent;

      // 4. To the screen.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.useProgram(display.program);
      bindTexture(display, 'uTrail', next.texture);
      gl.uniform2f(display.uniform('uRes'), width, height);
      gl.uniform1f(display.uniform('uAspect'), aspect);
      gl.uniform1f(display.uniform('uExposure'), 1.2);
      gl.uniform1f(display.uniform('uTime'), frame.time);
      gl.uniform3fv(display.uniform('uBackground'), look.background);
      gl.uniform1f(display.uniform('uRim'), rim);
      gl.uniform1f(display.uniform('uRing'), ring);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onLost);
      freeTrails();
      for (const t of state) {
        gl.deleteTexture(t.texture);
        gl.deleteFramebuffer(t.fbo);
      }
      for (const p of [sim, fade, points, display]) gl.deleteProgram(p.program);
    },
  };
}
