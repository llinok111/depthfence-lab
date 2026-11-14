// G4: real assertions, real numbers, exit code. No browser needed.
import { readFileSync } from 'node:fs';
import {
  MODES, projectDepth, unprojectDepth, ulp32, depthBinWidth, depthStepAnalytic,
  classifyPair, depthChart, rasterPlanePair, chooseFix, verifyFix, resolutionProfile,
  maxSafeDistance, chartDistances,
} from '../src/core.mjs';
import { oracleDepthChart } from './oracle.mjs';

const { scenes } = JSON.parse(readFileSync(new URL('../data/scenes.json', import.meta.url), 'utf8'));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

// A1 endpoints
for (const mode of MODES) {
  const near = 0.1, far = 3000;
  const lo = projectDepth(near, mode, near, far);
  const hi = projectDepth(far, mode, near, far);
  const ok = mode === 'standard' ? Math.abs(lo) < 1e-12 && Math.abs(hi - 1) < 1e-12
    : mode === 'reversed' ? Math.abs(lo - 1) < 1e-12 && Math.abs(hi) < 1e-12
      : Math.abs(hi - 1) < 1e-12 && lo > 0 && rel(lo, Math.log2(1.1) / Math.log2(3001)) < 1e-12;
  check(`A1 ${mode} endpoint mapping`, ok, `d(near)=${lo.toExponential(4)} d(far)=${hi.toFixed(15)}`);
}

// A2 roundtrip
{
  let worst = 0;
  for (const mode of MODES) for (const z of [0.11, 1, 17.3, 250, 2999.9]) {
    worst = Math.max(worst, rel(unprojectDepth(projectDepth(z, mode, 0.1, 3000), mode, 0.1, 3000), z));
  }
  check('A2 unproject(project(z)) roundtrip < 1e-11', worst < 1e-11, `worst rel err ${worst.toExponential(2)}`);
}

// A3 ULP
check('A3 ulp32(1) == 2^-23', ulp32(1) === 2 ** -23, `ulp32(1)=${ulp32(1)}`);
check('A3 ulp32(0.5) == 2^-24', ulp32(0.5) === 2 ** -24, `ulp32(0.5)=${ulp32(0.5)}`);
check('A3 ulp32(1e-4) == 2^-37', ulp32(1e-4) === 2 ** -37, `ulp32(1e-4)=${ulp32(1e-4)}`);

// A4 resolution at 1 km, three modes
{
  const near = 0.1, far = 3000;
  const s = depthBinWidth(1000, 'standard', near, far);
  const r = depthBinWidth(1000, 'reversed', near, far);
  const l = depthBinWidth(1000, 'log', near, far);
  check('A4 standard bin at 1 km in [0.5, 0.7] m', s > 0.5 && s < 0.7, `width=${s.toFixed(4)} m`);
  check('A4 reversed bin at 1 km < 1e-4 m', r > 0 && r < 1e-4, `width=${r.toExponential(3)} m`);
  check('A4 log bin at 1 km < 1e-3 m', l > 0 && l < 1e-3, `width=${l.toExponential(3)} m`);
  const relS = rel(s, depthStepAnalytic(1000, 'standard', near, far));
  const relR = rel(r, depthStepAnalytic(1000, 'reversed', near, far));
  check('A4 bisection vs closed-form within 1% (independent paths agree)',
    relS < 0.01 && relR < 0.01, `rel std ${relS.toExponential(2)}, rev ${relR.toExponential(2)}`);
  check('A4 standard/reversed ratio at 1 km > 5000', s / r > 5000, `ratio ${(s / r).toFixed(0)}x`);
  console.log(`      widths @1km: standard ${s.toFixed(4)} m, reversed ${r.toExponential(3)} m, log ${l.toExponential(3)} m`);
}

// A5 scale invariance 1e-6 .. 1e6
{
  const base = { near: 0.1, far: 3000, z: 1000 };
  const rows = [];
  for (const k of [1e-6, 1e-3, 1, 1e3, 1e6]) {
    const w = depthBinWidth(base.z * k, 'standard', base.near * k, base.far * k);
    rows.push({ k, normalized: w / k });
  }
  const worst = Math.max(...rows.map((r) => rel(r.normalized, rows[0].normalized)));
  check('A5 bin width scales linearly over 12 orders of magnitude', worst < 1e-9,
    `normalised ${rows.map((r) => r.normalized.toFixed(9)).join(' / ')} (worst rel ${worst.toExponential(2)})`);
  const decisions = [1e-6, 1, 1e6].map((k) => classifyPair(300 * k, 0.02 * k, 'standard', 0.1 * k, 3000 * k).tie);
  check('A5 tie decision invariant under scene scale', decisions.every((d) => d === decisions[0]), `decisions=${decisions.join(',')}`);
}

// A6 chart vs independent matrix oracle, 6 scenes x 3 modes
{
  let mismatches = 0, totalPixels = 0, totalTies = 0;
  const rows = [];
  for (const sc of scenes) {
    const distances = chartDistances(sc.near, sc.far, sc.maxDistance);
    for (const mode of MODES) {
      const cfg = { ...sc, tile: 16, mode, distances, separation: sc.separation };
      const a = depthChart(cfg);
      const b = oracleDepthChart(cfg);
      let mm = 0;
      const key = (t) => `${t.r}:${t.c}`;
      const bm = new Map(b.tiles.map((t) => [key(t), t.tie]));
      for (const t of a.tiles) if (bm.get(key(t)) !== t.tie) mm++;
      mismatches += mm;
      totalPixels += a.pixels;
      totalTies += a.ties;
      rows.push(`${sc.name}/${mode}: ${a.ties}/${a.pixels} tied, tiles ${a.tiles.length}, mismatch ${mm}`);
      check(`A6 ${sc.name}/${mode} tie flags identical to matrix oracle`, mm === 0 && a.pixels === b.pixels && a.ties === b.ties,
        `tiles ${a.tiles.length} mismatch ${mm} ties ${a.ties} oracle ${b.ties}`);
    }
  }
  console.log('      ' + rows.join('\n      '));
  check('A6 oracle comparison covered >200k depth samples', totalPixels > 200000 && mismatches === 0, `${totalPixels} samples, ${totalTies} tied, ${mismatches} mismatches`);
}

// A7 soundness of the analytic bound, and the guaranteed-safe direction
{
  let violations = 0, tiedTiles = 0;
  for (const sc of scenes) {
    const distances = chartDistances(sc.near, sc.far, sc.maxDistance);
    for (const mode of MODES) {
      const ch = depthChart({ ...sc, tile: 16, mode, distances, separation: sc.separation });
      for (const t of ch.tiles) {
        if (!t.tie) continue;
        tiedTiles++;
        if (!(depthBinWidth(t.z, mode, sc.near, sc.far) > sc.separation)) violations++;
      }
    }
  }
  check('A7 every tied tile had bin width > separation (0 silent ties)', violations === 0, `${violations} violations over ${tiedTiles} tied tiles`);

  let guaranteeOk = true, detail = [];
  for (const sc of scenes) {
    const distances = chartDistances(sc.near, sc.far, sc.maxDistance);
    for (const mode of MODES) {
      const maxW = Math.max(...distances.map((z) => depthBinWidth(z, mode, sc.near, sc.far)));
      const big = maxW * 1.05;
      const ch = depthChart({ ...sc, tile: 16, mode, distances, separation: big });
      if (ch.pixels > 0 && ch.ties !== 0) guaranteeOk = false;
      detail.push(`${sc.name}/${mode}:${ch.ties}/${ch.pixels}`);
    }
  }
  check('A7 separation >= 1.05*max bin width yields 0 ties in all 18 charts', guaranteeOk, detail.join(' '));
}

// A8 separation 0
{
  const sc = scenes[0];
  const ch = depthChart({ ...sc, tile: 16, mode: 'standard', distances: chartDistances(sc.near, sc.far, sc.maxDistance), separation: 0 });
  check('A8 separation 0 ties every sample', ch.ties === ch.pixels && ch.pixels > 1000, `${ch.ties}/${ch.pixels}`);
}

// A9 fix chooser
{
  const highway = { ...scenes[0], cameraClearance: scenes[0].cameraHeight, minSeparation: scenes[0].separation };
  const fix = chooseFix(highway);
  const v = fix.chosen ? verifyFix(highway, fix.chosen) : null;
  check('A9 highway: raising the near plane cannot reach 2 cm (clearance 1.7 m)',
    fix.candidates[0].feasible === false, `need worst width ${fix.candidates[0].worstWidth.toFixed(2)} m at near=${highway.near}`);
  check('A9 highway picks reversed-z', fix.chosen?.kind === 'reversed-z', `chosen=${fix.chosen?.kind} margin=${fix.margin?.toFixed(1)}x`);
  check('A9 chosen fix re-verified at 4 distances', v?.ok === true,
    v ? `worst ${v.worstWidth.toExponential(3)} m at ${v.rows.at(-1).z.toFixed(0)} m` : 'no fix');

  const cad = { ...scenes[2], cameraClearance: scenes[2].cameraHeight, minSeparation: scenes[2].separation };
  const fix2 = chooseFix(cad);
  const v2 = fix2.chosen ? verifyFix(cad, fix2.chosen) : null;
  check('A9 CAD scene picks the free raise-near fix', fix2.chosen?.kind === 'raise-near',
    `chosen=${fix2.chosen?.kind} near=${fix2.chosen?.near?.toFixed(4)} clearance=${cad.cameraClearance}`);
  check('A9 CAD fix re-verified', v2?.ok === true, v2 ? `worst ${v2.worstWidth.toExponential(3)} m` : 'no fix');
}

// A10 grazing-incidence control: world offset != eye-depth separation
{
  const sc = scenes[0];
  const r = rasterPlanePair({ ...sc, mode: 'standard' });
  const maxW = Math.max(...r.samples.map((p) => depthBinWidth(p.zEye, 'standard', sc.near, sc.far)));
  check('A10 grazing ground planes show 0 ties even where the buffer is coarse',
    r.ties === 0 && r.pixels > 1000 && r.minEyeDelta > sc.separation && maxW > 2 * sc.separation,
    `${r.pixels} px, ${r.ties} ties, min eye-depth delta ${r.minEyeDelta.toFixed(2)} m vs 0.02 m world offset, max bin ${maxW.toFixed(2)} m`);
}

// A11 monotone width + maxSafeDistance is the crossing point
{
  const prof = resolutionProfile({ near: 0.1, far: 3000, maxDistance: 3000, mode: 'standard', samples: 24 });
  let mono = true;
  for (let i = 1; i < prof.length; i++) if (prof[i].width < prof[i - 1].width * 0.999) mono = false;
  check('A11 standard bin width grows monotonically with distance', mono,
    `${prof[0].width.toExponential(2)} m at ${prof[0].z.toFixed(1)} m -> ${prof.at(-1).width.toFixed(2)} m at ${prof.at(-1).z.toFixed(0)} m`);

  const d = maxSafeDistance({ near: 0.1, far: 3000, mode: 'standard', tolerance: 0.02, maxDistance: 3000 });
  const wHere = depthBinWidth(d, 'standard', 0.1, 3000);
  const wAbove = depthBinWidth(d * 1.15, 'standard', 0.1, 3000);
  check('A11 maxSafeDistance(2 cm) is the actual crossing', wHere <= 0.02 && wAbove > 0.02,
    `z*=${d.toFixed(1)} m (width ${wHere.toFixed(4)}, at 1.15x ${wAbove.toFixed(4)})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT ${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length} passed / ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  failed: ${f.name} — ${f.detail}`);
  process.exit(1);
}
process.exit(0);
