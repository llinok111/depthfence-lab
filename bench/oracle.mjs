// Independent oracle for the depth analysis. Deliberately shares no constant,
// no formula and no code path with src/core.mjs:
//   - camera basis built by a lookAt matrix, not by hand
//   - rays obtained by *inverting* the projection matrix (unproject two NDC points)
//   - plane hit solved with an implicit plane equation n.p = c
//   - window depth = (ndcZ + 1) / 2
// It imports nothing from core.

const F32 = Math.fround;

function lookAt(eye, target) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target));      // camera looks down -z
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [
    [x[0], x[1], x[2], -dot(x, eye)],
    [y[0], y[1], y[2], -dot(y, eye)],
    [z[0], z[1], z[2], -dot(z, eye)],
    [0, 0, 0, 1],
  ];
}

function perspective(fovY, aspect, near, far, mode = 'standard') {
  const f = 1 / Math.tan(fovY / 2);
  // standard: near->-1, far->+1 ; reversed: near->+1, far->-1
  const a = (far + near) / (near - far);
  const b = (2 * far * near) / (near - far);
  const z2 = mode === 'reversed' ? -a : a;
  const z3 = mode === 'reversed' ? -b : b;
  return [
    [f / aspect, 0, 0, 0],
    [0, f, 0, 0],
    [0, 0, z2, z3],
    [0, 0, -1, 0],
  ];
}

function matVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2] + m[0][3] * v[3],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2] + m[1][3] * v[3],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2] + m[2][3] * v[3],
    m[3][0] * v[0] + m[3][1] * v[1] + m[3][2] * v[2] + m[3][3] * v[3],
  ];
}

/**
 * Rasterise the same two horizontal planes with a full matrix pipeline.
 * Returns a per-pixel tie mask (Uint8Array) plus counts, so the caller can
 * compare sets, not just totals.
 */
export function oraclePlanePair(cfg) {
  const {
    width = 256, height = 144, fovY = Math.PI / 3, near, far, mode,
    cameraHeight, separation, pitch = 0.05,
  } = cfg;
  const aspect = width / height;
  const eye = [0, cameraHeight, 0];
  const target = [0, cameraHeight - Math.sin(pitch) * 100, -Math.cos(pitch) * 100];
  const V = lookAt(eye, target);
  const P = perspective(fovY, aspect, near, far, mode);
  // inverse of P (analytic, computed from P's own entries, no shared constants)
  const p22 = P[2][2], p23 = P[2][3];
  const invP = [
    [1 / P[0][0], 0, 0, 0],
    [0, 1 / P[1][1], 0, 0],
    [0, 0, 0, -1],
    [0, 0, 1 / p23, p22 / p23],
  ];
  // inverse view = transpose of rotation block, then translate
  const Rt = [
    [V[0][0], V[1][0], V[2][0], 0],
    [V[0][1], V[1][1], V[2][1], 0],
    [V[0][2], V[1][2], V[2][2], 0],
    [0, 0, 0, 1],
  ];
  const t = [V[0][3], V[1][3], V[2][3]];
  const invV = Rt.map((r, i) => [r[0], r[1], r[2], i < 3 ? -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]) : 1]);

  const mask = new Uint8Array(width * height).fill(255); // 255 = pixel not counted
  let counted = 0;
  let ties = 0;
  let minTieZ = Infinity, maxTieZ = -Infinity;

  for (let j = 0; j < height; j++) {
    const ny = 1 - (2 * (j + 0.5)) / height;
    for (let i = 0; i < width; i++) {
      const nx = (2 * (i + 0.5)) / width - 1;
      // unproject the NDC point at z=-1 and z=+1 to world space
      const a = matVec(invV, matVec(invP, [nx, ny, -1, 1]));
      const b = matVec(invV, matVec(invP, [nx, ny, 1, 1]));
      const pa = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
      const pb = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
      const dir = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      // plane y = planeY  ->  t = (planeY - pa.y) / dir.y
      if (Math.abs(dir[1]) < 1e-15) continue;
      const t0 = (0 - pa[1]) / dir[1];
      const t1 = (separation - pa[1]) / dir[1];
      const p0 = [pa[0] + dir[0] * t0, 0, pa[2] + dir[2] * t0];
      const p1 = [pa[0] + dir[0] * t1, separation, pa[2] + dir[2] * t1];
      const c0 = matVec(P, matVec(V, [p0[0], p0[1], p0[2], 1]));
      const c1 = matVec(P, matVec(V, [p1[0], p1[1], p1[2], 1]));
      if (!(c0[3] > 0) || !(c1[3] > 0)) continue;
      const z0 = c0[3], z1 = c1[3]; // eye distance = w
      if (!(z0 > near && z0 < far) || !(z1 > near && z1 < far)) continue;
      const d0 = F32((c0[2] / c0[3] + 1) / 2);
      const d1 = F32((c1[2] / c1[3] + 1) / 2);
      counted++;
      const k = j * width + i;
      if (d0 === d1) {
        mask[k] = 1; ties++;
        if (z0 < minTieZ) minTieZ = z0;
        if (z0 > maxTieZ) maxTieZ = z0;
      } else mask[k] = 0;
    }
  }
  return { pixels: counted, ties, mask, minTieZ: ties ? minTieZ : null, maxTieZ: ties ? maxTieZ : null };
}

/** Ground truth used by the checker: does every visible pixel of plane 1 reach the colour pass? */
export function oracleVisible(mode, near, far, width, height, counts) {
  // Nothing here needs a GPU: if both planes project to the same float32 depth
  // in a pixel, the later draw wins nondeterministically -> that pixel is
  // "unstable". This helper only exists so the README's wording matches code.
  return counts.pixels - counts.ties;
}

/**
 * Independent quantisation-chart oracle: same tiles, but the depth is obtained
 * by multiplying a view-space point through a 4x4 projection matrix and taking
 * (ndcZ+1)/2, instead of the closed-form rational. No constant is shared.
 */
export function oracleDepthChart(cfg) {
  const { width = 256, height = 144, tile = 16, near, far, mode = 'standard', distances, separation } = cfg;
  const cols = Math.floor(width / tile);
  const rows = Math.floor(height / tile);
  const aspect = width / height;
  const P = perspective(Math.PI / 3, aspect, near, far, mode);
  const tiles = [];
  let pixels = 0, ties = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = distances[(r * cols + c) % distances.length];
      if (!(z > near && z + separation < far)) continue;
      const take = (zz) => {
        if (mode === 'log') return F32(Math.log(1 + zz) / Math.log(1 + far)); // ln ratio, not log2
        const clip = matVec(P, [0, 0, -zz, 1]);
        return F32((clip[2] / clip[3] + 1) / 2);
      };
      const d0 = take(z);
      const d1 = take(z + separation);
      const px = tile * tile;
      const tie = d0 === d1;
      tiles.push({ r, c, z, d0, d1, px, tie });
      pixels += px;
      if (tie) ties += px;
    }
  }
  return { cols, rows, pixels, ties, tiles };
}
