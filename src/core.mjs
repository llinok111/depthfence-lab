// src/core.mjs — depth-buffer precision analysis. Pure math.
// No three.js, no DOM, no I/O, no environment reads. Node-importable.
//
// Window depth in [0,1], OpenGL-style, as WebGL uses:
//   standard: d = f/(f-n) * (1 - n/z)          -> 0 at z=near, 1 at z=far
//   reversed: d = n/(f-n) * (f/z - 1)          -> 1 at z=near, 0 at z=far
//   log:      d = log2(1+z) / log2(1+far)      -> 0 at z=0,    1 at z=far
// The log formula is the one three.js logdepthbuf uses with
// logDepthBufFC = 2/log2(far+1) (frag depth = log2(1+w) * FC * 0.5).

export const MODES = Object.freeze(['standard', 'reversed', 'log']);
const F32 = Math.fround;

const _buf = new ArrayBuffer(4);
const _f32 = new Float32Array(_buf);
const _u32 = new Uint32Array(_buf);

/** Spacing between the float32 nearest to x and the next float32 above it. */
export function ulp32(x) {
  if (!Number.isFinite(x)) return NaN;
  const a = Math.abs(x);
  _f32[0] = a;              // quantise the base first, then step: no double residue
  const base = _f32[0];
  const u = _u32[0];
  if (u === 0x7f7fffff) return Infinity;
  _u32[0] = u + 1;
  return _f32[0] - base;
}

export function projectDepth(z, mode, near, far) {
  if (!(z > 0) || !(near > 0) || !(far > near)) {
    throw new RangeError(`projectDepth: need 0<z, 0<near<far (got z=${z}, near=${near}, far=${far})`);
  }
  if (mode === 'standard') return (far / (far - near)) * (1 - near / z);
  if (mode === 'reversed') return (near / (far - near)) * (far / z - 1);
  if (mode === 'log') return Math.log2(1 + z) / Math.log2(1 + far);
  throw new RangeError(`unknown mode: ${mode}`);
}

export function unprojectDepth(d, mode, near, far) {
  if (mode === 'standard') {
    const k = far / (far - near);
    return near / (1 - d / k);
  }
  if (mode === 'reversed') {
    const k = near / (far - near);
    return (far * k) / (d + k);
  }
  if (mode === 'log') return Math.pow(2, d * Math.log2(1 + far)) - 1;
  throw new RangeError(`unknown mode: ${mode}`);
}

// smallest dz>0 such that the stored float32 depth changes (bisection)
function nextBoundary(z, mode, near, far) {
  const d0 = F32(projectDepth(z, mode, near, far));
  const differs = (dz) => F32(projectDepth(z + dz, mode, near, far)) !== d0;
  let lo = 0, hi = Math.max(z * 1e-6, 1e-15), guard = 0;
  while (!differs(hi)) { lo = hi; hi *= 2; if (++guard > 400) return Infinity; }
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (differs(m)) hi = m; else lo = m; }
  return hi;
}

function prevBoundary(z, mode, near, far) {
  const d0 = F32(projectDepth(z, mode, near, far));
  const differs = (dz) => F32(projectDepth(z - dz, mode, near, far)) !== d0;
  let lo = 0, hi = Math.max(z * 1e-6, 1e-15), guard = 0;
  while (!differs(hi)) { lo = hi; hi *= 2; if (++guard > 400) return Infinity; }
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (differs(m)) hi = m; else lo = m; }
  return hi;
}

/**
 * Width of the float32 depth quantisation bin that contains z, in world units.
 * This is the resolution: any two surfaces closer than this *can* land on the
 * same depth value; anything at least this far apart provably cannot.
 */
export function depthBinWidth(z, mode, near, far) {
  const up = nextBoundary(z, mode, near, far);
  const down = prevBoundary(z, mode, near, far);
  return up + down;
}

/** First-order cross-check: ULP(d) / |dd/dz|. Independent of the bisection. */
export function depthStepAnalytic(z, mode, near, far) {
  const d = projectDepth(z, mode, near, far);
  const h = Math.max(z * 1e-7, 1e-12);
  const dd = Math.abs(projectDepth(z + h, mode, near, far) - d) / h;
  return ulp32(d) / dd;
}

/** Two surfaces separated by `separation` metres of eye depth at distance z. */
export function classifyPair(z, separation, mode, near, far) {
  const d0 = F32(projectDepth(z, mode, near, far));
  const d1 = F32(projectDepth(z + separation, mode, near, far));
  const width = depthBinWidth(z, mode, near, far);
  const ulps = Math.abs(d1 - d0) / ulp32(Math.max(d0, d1));
  return { z, separation, mode, d0, d1, ulps, width, tie: d0 === d1, provablySafe: separation >= width };
}

/** Depth resolution over a log-spaced grid of eye distances. */
export function resolutionProfile({ near, far, maxDistance, mode, samples = 48 }) {
  const n = Math.max(4, samples | 0);
  const out = [];
  const lo = Math.log(near * 1.0001);
  const hi = Math.log(Math.min(maxDistance, far * (1 - 1e-9)));
  for (let i = 0; i < n; i++) {
    const z = Math.exp(lo + ((hi - lo) * i) / (n - 1));
    out.push({ z, width: depthBinWidth(z, mode, near, far) });
  }
  return out;
}

/**
 * Analytic tie prediction over a set of {z} samples: a pixel at eye distance z
 * is at risk iff its bin is wider than the separation. Sound by construction:
 * if separation >= binWidth, z+separation must cross the next quantisation
 * boundary, so the two float32 depths cannot be equal.
 */
export function predictTies(zs, separation, mode, near, far) {
  let risk = 0;
  for (const z of zs) if (depthBinWidth(z, mode, near, far) > separation) risk++;
  return { samples: zs.length, atRisk: risk };
}

/**
 * Quantisation chart: a grid of fronto-parallel decal quads (tile x tile px),
 * one per eye distance, each with a twin `separation` metres further away.
 * Depth is constant inside a quad, so the chart isolates exactly the quantity
 * under test. Every counted pixel is a real depth-buffer sample.
 */
export function depthChart(cfg) {
  const {
    width = 256, height = 144, tile = 16, near, far, mode, distances, separation,
  } = cfg;
  const cols = Math.floor(width / tile);
  const rows = Math.floor(height / tile);
  const tiles = [];
  let pixels = 0, ties = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = distances[(r * cols + c) % distances.length];
      if (!(z > near && z + separation < far)) continue;
      const d0 = F32(projectDepth(z, mode, near, far));
      const d1 = F32(projectDepth(z + separation, mode, near, far));
      const px = tile * tile;
      const tie = d0 === d1;
      tiles.push({ r, c, z, d0, d1, px, tie });
      pixels += px;
      if (tie) ties += px;
    }
  }
  return { cols, rows, tile, pixels, ties, tieFraction: pixels ? ties / pixels : 0, tiles, mode, near, far, separation };
}

/**
 * Per-pixel ground-plane rasteriser (rays from a pitched camera hitting
 * y=0 and y=separation). Used as the grazing-incidence control: along a
 * grazing ray the two planes are separated by separation/|dy| metres of eye
 * depth, not by `separation`, which is why road paint does NOT z-fight at the
 * horizon even with a bad near plane.
 */
export function rasterPlanePair(cfg) {
  const {
    width = 256, height = 144, fovY = Math.PI / 3, near, far, mode,
    cameraHeight, separation, pitch = 0.05,
  } = cfg;
  const aspect = width / height;
  const tanY = Math.tan(fovY / 2);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fwd = [0, -sp, -cp];
  const right = [1, 0, 0];
  const up = [0, cp, -sp];

  const pixels = [];
  let ties = 0, minEyeDelta = Infinity, maxEyeDelta = 0;
  for (let j = 0; j < height; j++) {
    const ndcY = 1 - (2 * (j + 0.5)) / height;
    for (let i = 0; i < width; i++) {
      const ndcX = (2 * (i + 0.5)) / width - 1;
      const sx = ndcX * tanY * aspect;
      const sy = ndcY * tanY;
      const dy = up[1] * sy + fwd[1];
      if (dy >= 0) continue;                       // ray leaves upwards
      const z0 = -(cameraHeight / dy);
      const z1 = -((cameraHeight - separation) / dy);
      if (!(z0 > near && z0 < far) || !(z1 > near && z1 < far)) continue;
      const d0 = F32(projectDepth(z0, mode, near, far));
      const d1 = F32(projectDepth(z1, mode, near, far));
      const tie = d0 === d1;
      pixels.push({ i, j, zEye: z0, zNear: z1, d0, d1, tie, eyeDelta: z0 - z1 });
      if (tie) ties++;
      minEyeDelta = Math.min(minEyeDelta, z0 - z1);
      maxEyeDelta = Math.max(maxEyeDelta, z0 - z1);
    }
  }
  return {
    width, height, mode, near, far, separation,
    pixels: pixels.length, ties, tieFraction: pixels.length ? ties / pixels.length : 0,
    minEyeDelta: pixels.length ? minEyeDelta : null,
    maxEyeDelta: pixels.length ? maxEyeDelta : null,
    samples: pixels,
  };
}

/**
 * Cheapest fix that makes every sampled distance resolve `minSeparation`.
 * Candidates, cheapest first:
 *   1. raise the near plane (free, clips geometry closer than cameraClearance)
 *   2. reversed-Z (no clipping, no extra shader work)
 *   3. logarithmic depth (works, costs a gl_FragDepth write)
 */
export function chooseFix(scene) {
  const { near, far, cameraClearance, minSeparation, maxDistance, samples = 32 } = scene;
  const grid = buildGrid(near, far, maxDistance, samples);
  const worst = (mode, nearVal) => {
    let m = 0;
    for (const z of grid) m = Math.max(m, depthBinWidth(z, mode, nearVal, far));
    return m;
  };
  const candidates = [];

  let lo = near, hi = Math.min(cameraClearance, far / 10), bestNear = null;
  if (worst('standard', hi) <= minSeparation) {
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (worst('standard', mid) <= minSeparation) { hi = mid; bestNear = mid; } else lo = mid;
    }
  }
  candidates.push({
    kind: 'raise-near',
    feasible: bestNear !== null,
    near: bestNear,
    clips: false,
    worstWidth: bestNear === null ? Infinity : worst('standard', bestNear),
    mode: 'standard',
    note: 'free; geometry closer than the new near plane is clipped',
  });

  for (const mode of ['reversed', 'log']) {
    const w = worst(mode, near);
    candidates.push({
      kind: mode === 'reversed' ? 'reversed-z' : 'log-depth',
      feasible: w <= minSeparation,
      near,
      clips: false,
      worstWidth: w,
      mode,
      note: mode === 'reversed' ? 'needs a reversed projection; no shader edit' : 'needs a gl_FragDepth write',
    });
  }
  const order = { 'raise-near': 0, 'reversed-z': 1, 'log-depth': 2 };
  const feasible = candidates.filter((c) => c.feasible && !c.clips).sort((a, b) => order[a.kind] - order[b.kind]);
  const chosen = feasible[0] || null;
  return { chosen, candidates, margin: chosen ? minSeparation / chosen.worstWidth : null, ok: !!chosen };
}

function buildGrid(near, far, maxDistance, samples) {
  const n = Math.max(4, samples | 0);
  const top = Math.min(maxDistance, far * (1 - 1e-9));
  const lo = Math.log(near * 1.0001);
  const hi = Math.log(top);
  const g = [];
  for (let i = 0; i < n; i++) g.push(Math.exp(lo + ((hi - lo) * i) / (n - 1)));
  return g;
}

/** Re-check a chosen fix at four distances inside the scene. */
export function verifyFix(scene, chosen) {
  const { near, far, maxDistance, minSeparation } = scene;
  const n = chosen.near ?? near;
  const zs = [near * 10, maxDistance / 3, (2 * maxDistance) / 3, maxDistance].filter((z) => z > n && z < far);
  const rows = zs.map((z) => ({ z, width: depthBinWidth(z, chosen.mode, n, far) }));
  return {
    rows,
    worstWidth: Math.max(...rows.map((r) => r.width)),
    ok: rows.every((r) => r.width <= minSeparation),
  };
}

/** Where does the buffer stop resolving `tolerance`? (largest z with width<=tol) */
export function maxSafeDistance({ near, far, mode, tolerance, maxDistance }) {
  const top = Math.min(maxDistance, far * (1 - 1e-9));
  if (depthBinWidth(top, mode, near, far) <= tolerance) return top;
  if (depthBinWidth(near * 1.01, mode, near, far) > tolerance) return near;
  let lo = near * 1.01, hi = top;
  for (let i = 0; i < 50; i++) {
    const m = Math.sqrt(lo * hi);
    if (depthBinWidth(m, mode, near, far) <= tolerance) lo = m; else hi = m;
  }
  return lo;
}

export function summarizeScene(scene) {
  const rows = MODES.map((mode) => {
    const prof = resolutionProfile({ near: scene.near, far: scene.far, maxDistance: scene.maxDistance, mode, samples: 24 });
    const w = prof.reduce((a, b) => (b.width > a.width ? b : a));
    return { mode, worstWidth: w.width, worstZ: w.z };
  });
  return { name: scene.name, near: scene.near, far: scene.far, minSeparation: scene.minSeparation, rows };
}

/** Deterministic log-spaced distances used by the chart and the verifier. */
export function chartDistances(near, far, maxDistance, n = 24) {
  const k = Math.max(2, n | 0);
  const top = Math.min(maxDistance, far * 0.98);
  const lo = Math.log(near * 10);
  const hi = Math.log(top);
  const out = [];
  for (let i = 0; i < k; i++) out.push(Math.exp(lo + ((hi - lo) * i) / (k - 1)));
  return out;
}
