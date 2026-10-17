// GLSL for the flow visualizer. Four passes per frame:
//   1. SIM      — advance every particle through a curl-noise field around the ring
//   2. FADE     — the previous frame's trails, faded, drifted outward and turned (feedback)
//   3. POINTS   — draw particles additively onto the faded trails
//   4. DISPLAY  — glow, tone-map and grade the trails onto the screen
// Particle state lives in an RGBA32F texture: xy = position, z = life (1→0), w = seed.
// Positions are in "ring space": y spans -1..1, x is scaled by the aspect ratio.

/** One oversized triangle covering the viewport; no vertex buffers needed. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 3D simplex noise: Ian McEwan / Ashima Arts (MIT), https://github.com/ashima/webgl-noise
const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
    i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
    i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}`;

const HASH = /* glsl */ `
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

export const SIM_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform float uTime, uDt;
uniform float uRadius, uSpread, uSwirl, uTurb, uNoiseScale, uFlow, uSpeed, uPull, uBurst;
uniform float uBass, uMid, uBeat, uUp, uDown;
out vec4 outState;
${SIMPLEX}
${HASH}
// Divergence-free flow from a noise potential: particles swirl like ink, never clump.
vec2 curl(vec2 p, float t) {
  const float e = 0.02;
  float a = snoise(vec3(p.x, p.y + e, t));
  float b = snoise(vec3(p.x, p.y - e, t));
  float c = snoise(vec3(p.x + e, p.y, t));
  float d = snoise(vec3(p.x - e, p.y, t));
  return vec2(a - b, d - c) / (2.0 * e);
}
void main() {
  vec4 s = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
  vec2 x = s.xy;
  float seed = s.w;
  float life = s.z - uDt * (0.18 + 0.32 * fract(seed * 91.7));
  float r = length(x);
  if (life <= 0.0 || r > 3.0) {
    // Reborn somewhere on the ring.
    float a = hash(vec2(seed * 1000.0, uTime)) * 6.2831853;
    float k = hash(vec2(uTime * 1.3, seed * 777.0)) - 0.5;
    float rr = uRadius * (1.0 + k * uSpread);
    outState = vec4(rr * cos(a), rr * sin(a), 1.0, seed);
    return;
  }
  vec2 d = x / max(r, 1e-4);
  vec2 tangent = vec2(-d.y, d.x);
  // Bass and onsets swell the ring; a like blooms it outward, a dislike tightens it.
  float target = uRadius * (1.0 + 0.22 * uBass + 0.12 * uBeat + 0.18 * uUp - 0.1 * uDown);
  float jitter = fract(seed * 17.31);
  vec2 v = curl(x * uNoiseScale, uTime * 0.12 * uFlow) * uTurb * (0.3 + 0.9 * uMid + 1.5 * uDown)
    + tangent * uSwirl * (0.6 + 0.8 * uBass)
    + d * (target - r) * uPull * (1.0 + 2.0 * abs(target - r))
    + d * (uBeat * uBurst + uUp * 1.4) * (0.3 + jitter);
  x += v * uDt * uSpeed * 0.35;
  outState = vec4(x, life, seed);
}`;

export const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform float uAspect, uFade, uZoom, uRot, uTime, uWarp;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  float cs = cos(uRot), sn = sin(uRot);
  // Sampling slightly inward makes old light drift outward, like smoke off the ring.
  c = mat2(cs, -sn, sn, cs) * c * (1.0 - uZoom);
  c += uWarp * vec2(sin(c.y * 7.0 + uTime * 0.5), cos(c.x * 7.0 - uTime * 0.4));
  vec2 suv = c / vec2(uAspect, 1.0) + 0.5;
  outColor = vec4(texture(uPrev, suv).rgb * uFade, 1.0);
}`;

export const POINTS_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform int uSide;
uniform float uAspect, uPointSize, uHigh, uTime, uUp, uDown, uDensity;
uniform vec3 uColorA, uColorB, uHighlight, uWarm, uCool;
out vec3 vColor;
void main() {
  vec4 s = texelFetch(uState, ivec2(gl_VertexID % uSide, gl_VertexID / uSide), 0);
  gl_Position = vec4(s.x / uAspect, s.y, 0.0, 1.0);
  float seed = s.w;
  float fade = smoothstep(0.0, 0.2, s.z) * (1.0 - smoothstep(0.85, 1.0, s.z));
  float sparkle = step(0.9, fract(seed * 7.31 + uTime * 0.7)) * uHigh;
  gl_PointSize = uPointSize * (0.6 + 0.8 * fract(seed * 13.7)) * (1.0 + 1.8 * sparkle);
  float angle = atan(s.y, s.x);
  vec3 c = mix(uColorA, uColorB, 0.5 + 0.5 * sin(angle * 2.0 + uTime * 0.15 + seed * 6.2831));
  c = mix(c, uHighlight, clamp(step(0.94, fract(seed * 31.1)) + sparkle * 0.6, 0.0, 1.0));
  c = mix(c, uWarm, clamp(uUp, 0.0, 1.0) * 0.65);
  c = mix(c, uCool, clamp(uDown, 0.0, 1.0) * 0.65);
  vColor = c * fade * uDensity;
}`;

export const POINTS_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  float a = 1.0 - smoothstep(0.0, 0.5, length(gl_PointCoord - 0.5));
  outColor = vec4(vColor * a, 1.0);
}`;

export const DISPLAY_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform vec2 uRes;
uniform float uAspect, uExposure, uTime;
uniform vec3 uBackground;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 t = texture(uTrail, uv).rgb;
  // Cheap glow: two rings of taps around each pixel.
  vec3 glow = vec3(0.0);
  vec2 px = 1.0 / uRes;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    vec2 dir = vec2(cos(a), sin(a));
    glow += texture(uTrail, uv + dir * px * 6.0).rgb;
    glow += texture(uTrail, uv + dir * px * 18.0).rgb * 0.6;
  }
  t += glow * 0.04;
  vec3 col = 1.0 - exp(-t * uExposure);
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  vec3 bg = uBackground * (1.25 - 0.9 * length(c));
  col += bg * (1.0 - col);
  // Dither away banding in the long dark gradients.
  col += (fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;
