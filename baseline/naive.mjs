// The baseline this tool is compared against: "render the frame and read the
// depth buffer back". No analytic model — it must rasterise every pixel before
// it can say anything, and it cannot answer "how far is it safe" without a
// scan. Also contains the naive near-plane-only heuristic, which is what most
// engines actually do ("near=0.1, depth24, must be fine").
import { rasterPlanePair, projectDepth, ulp32 } from '../src/core.mjs';

export function renderAndCountTies(cfg) {
  const r = rasterPlanePair(cfg);
  return { pixels: r.pixels, ties: r.ties, tieFraction: r.tieFraction, maxTieZ: r.maxTieZ };
}

/**
 * Naive rule: look at the depth resolution at the near plane and extrapolate
 * that the buffer is "precise enough" because the near-plane resolution is
 * excellent. Wrong for any scene with a large far/near ratio.
 */
export function nearPlaneOnlyCheck({ near, far, minSeparation }) {
  const d = projectDepth(near * 1.0001, 'standard', near, far);
  const stepAtNear = (ulp32(d) * near * near) / near; // ulp * z^2/n at z=near
  return { stepAtNear, verdict: stepAtNear <= minSeparation ? 'safe' : 'z-fight' };
}

/** Brute-force search for the first distance where ties appear, by rendering. */
export function scanForFirstTie(cfg, steps = 24) {
  const maxD = Math.min(cfg.far * 0.999, cfg.maxDistance ?? cfg.far);
  let lo = cfg.near * 2;
  for (let i = 0; i < steps; i++) {
    const z = lo + ((maxD - lo) * i) / (steps - 1);
    const r = rasterPlanePair({ ...cfg, cameraHeight: z * Math.tan(cfg.pitch || 0.05) + z * 0.02 });
    if (r.ties > 0) return { firstTieZ: r.minTieZ, ties: r.ties };
  }
  return { firstTieZ: null, ties: 0 };
}
