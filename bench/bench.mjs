// G5: warmup 1, >=5 reps, median + cold start + p95 + stddev. Writes bench/result.json.
import { writeFileSync } from 'node:fs';
import { depthBinWidth, depthChart, rasterPlanePair, chartDistances, chooseFix, verifyFix, MODES } from '../src/core.mjs';
import { oracleDepthChart } from './oracle.mjs';
import { renderAndCountTies, nearPlaneOnlyCheck } from '../baseline/naive.mjs';

const { scenes } = JSON.parse((await import('node:fs')).readFileSync(new URL('../data/scenes.json', import.meta.url), 'utf8'));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return {
    median: s[Math.floor(s.length / 2)],
    min: s[0], max: s.at(-1),
    p95: s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)],
    stddev: sd, relStddev: mean ? sd / mean : 0,
  };
};

// --- workload A: certify 200 (near,far,z,separation) setups analytically
const QUERIES = 2000;
const setups = [];
for (let i = 0; i < QUERIES; i++) {
  const near = 0.02 * Math.pow(1.35, i % 30);
  const far = near * 1000 * Math.pow(1.8, i % 11);
  const z = near * 10 * Math.pow(far / (near * 10), (i % 37) / 37);
  setups.push({ near, far, z });
}
function certifyBatch() {
  let acc = 0;
  for (const s of setups) acc += depthBinWidth(s.z, 'standard', s.near, s.far);
  return acc;
}

// --- workload B: baseline "render and read the depth buffer back" (per-pixel)
const FRAMES = 40;
const frames = [];
for (let i = 0; i < FRAMES; i++) {
  const sc = scenes[i % scenes.length];
  frames.push({ ...sc, mode: 'standard', width: 256, height: 144 });
}
function renderBatch() {
  let acc = 0;
  for (const f of frames) acc += rasterPlanePair(f).ties;
  return acc;
}

certifyBatch(); // warmup 1
renderBatch();
const certRuns = [], rendRuns = [];
let certCold = null, rendCold = null;
for (let r = 0; r < 7; r++) {
  const t0 = now(); certifyBatch(); const t1 = now();
  certRuns.push(t1 - t0); if (certCold === null) certCold = t1 - t0;
  const t2 = now(); renderBatch(); const t3 = now();
  rendRuns.push(t3 - t2); if (rendCold === null) rendCold = t3 - t2;
}
const cert = stats(certRuns), rend = stats(rendRuns);

// --- evidence blocks
const res1km = {};
for (const m of MODES) res1km[m] = depthBinWidth(1000, m, 0.1, 3000);

const oracle = { samples: 0, mismatches: 0, tied: 0, charts: 0 };
for (const sc of scenes) {
  const distances = chartDistances(sc.near, sc.far, sc.maxDistance);
  for (const mode of MODES) {
    const cfg = { ...sc, tile: 16, mode, distances, separation: sc.separation };
    const a = depthChart(cfg), b = oracleDepthChart(cfg);
    const bm = new Map(b.tiles.map((t) => [`${t.r}:${t.c}`, t.tie]));
    for (const t of a.tiles) if (bm.get(`${t.r}:${t.c}`) !== t.tie) oracle.mismatches++;
    oracle.samples += a.pixels; oracle.tied += a.ties; oracle.charts++;
  }
}

const fixScene = { ...scenes[0], cameraClearance: scenes[0].cameraHeight, minSeparation: scenes[0].separation };
const fix = chooseFix(fixScene);
const fixVerify = fix.chosen ? verifyFix(fixScene, fix.chosen) : null;
const cadScene = { ...scenes[2], cameraClearance: scenes[2].cameraHeight, minSeparation: scenes[2].separation };
const cadFix = chooseFix(cadScene);
const cadVerify = cadFix.chosen ? verifyFix(cadScene, cadFix.chosen) : null;

const naive = nearPlaneOnlyCheck({ near: fixScene.near, far: fixScene.far, minSeparation: fixScene.separation });
const rendered = renderAndCountTies({ ...scenes[0], mode: 'standard' });

const out = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  warmup: 1,
  reps: 7,
  workload: { certifyQueries: QUERIES, baselineFrames: FRAMES, framePixels: 19968 },
  certify: {
    coldMs: certCold, ...cert, perQueryUs: (cert.median * 1000) / QUERIES,
  },
  renderBaseline: {
    coldMs: rendCold, ...rend, perFrameMs: rend.median / FRAMES,
  },
  speedupPerAnswer: (rend.median * 1000 / FRAMES) / (cert.median * 1000 / QUERIES),
  resolutionAt1km_near0_1_far3000: {
    standard_m: res1km.standard, reversed_m: res1km.reversed, log_m: res1km.log,
    standardOverReversed: res1km.standard / res1km.reversed,
    standardOverLog: res1km.standard / res1km.log,
  },
  oracleAgreement: oracle,
  fix: {
    highway: {
      chosen: fix.chosen?.kind ?? null,
      margin: fix.margin,
      candidates: fix.candidates.map((c) => ({ kind: c.kind, feasible: c.feasible, worstWidth: Number.isFinite(c.worstWidth) ? c.worstWidth : null, near: c.near })),
      verifyWorst: fixVerify?.worstWidth ?? null,
      verifyOk: fixVerify?.ok ?? false,
    },
    cad: {
      chosen: cadFix.chosen?.kind ?? null,
      near: cadFix.chosen?.near ?? null,
      margin: cadFix.margin,
      verifyOk: cadVerify?.ok ?? false,
      verifyWorst: cadVerify?.worstWidth ?? null,
    },
  },
  naiveNearPlaneCheck: { verdict: naive.verdict, stepAtNear_m: naive.stepAtNear },
  grazingControl: { pixels: rendered.pixels, ties: rendered.ties },
};
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
