// GTA VI trophy rarity forecaster (make.fun gta6-trophy-rarity-forecast-01).
//
// Reads one case /input/<id>.in (Exophase reads of the game's trophy page
// before the checkpoint) and writes /output/<id>.out: for each of the 55
// trophies, five quantiles (5/25/50/75/95%) of its earn rate at the target.
//
// Model (per trophy, all in logit space, rates in percent clamped to
// [0.01, 99.99]):
//
//   rate = earned / tracked.  Exophase's tracked-player count N grows as
//   players sync, and each refresh dilutes the rates toward the earn rate
//   of the broader player population.  So instead of extrapolating the
//   rate itself, we model the two counts that make it:
//
//   * E(N): a least-squares line of earned count E on tracked N over the
//     recent reads (last 36h; launch-night reads describe a different
//     player mix).  Its slope is the marginal earn rate among newly
//     tracked players; the intercept is the early core's earned count.
//   * N(t): log N linear in time over the last 48h of reads, slope
//     capped, extrapolated to the target (capped, so a hot launch day
//     cannot send N to infinity).
//   * Trend: logit(rate) linear in ln(1 + hours since launch) over the
//     recent reads — a saturating curve, so a 4.5-day horizon cannot
//     explode the way a log-linear extrapolation would.
//   * The median rate blends the E(N) forecast and the trend forecast
//     in logit space, weighted by how much N varied in the window.
//   * The spread combines the fit residual with a random-walk term that
//     grows with the horizon, like the house baseline's.
//
//   Flat history (no variation in N or rates, as on launch night): the
//   page is stale and Exophase refreshes on its own schedule, so we mix
//   two scenarios — a refresh before the target (tracked players jump,
//   rates dilute) and no refresh (rates stay) — and take the quantiles
//   of that mixture.
//
// Deterministic: pure arithmetic, no randomness, no clock. Two runs on
// the same case write the same bytes.

import * as fs from "node:fs";
import * as path from "node:path";

const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

type Trophy = { id: number; name: string; description: string; tier: string; points: number; secret: boolean };
type Read = { slot: string; at: string; players_tracked: number; trophies_earned: number; rates: number[] };
type Case = {
  schema: string; id: string; at: string; horizon_minutes: number; target: string;
  levels: number[]; game: unknown; trophies: Trophy[]; history: Read[]; notes?: unknown;
};

function clampRate(r: number): number {
  if (!Number.isFinite(r)) return 0.01;
  return Math.min(99.99, Math.max(0.01, r));
}
function logit(pct: number): number {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
}
function invLogit(x: number): number {
  if (x > 20) return 99.99;
  if (x < -20) return 0.01;
  return clampRate(100 / (1 + Math.exp(-x)));
}
function round4(x: number): number {
  const r = Math.round(x * 10000) / 10000;
  return Math.min(100, Math.max(0, r));
}
// Least squares y = a + b*x. Returns [a, b, residualStd].
function ols(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return [ys[0], 0, 0];
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return [a, b, resid];
}
function quantileOfMixture(
  // Two lognormal-ish scenarios on the logit scale: (medianLogit, spread, weight).
  scenarios: Array<[number, number, number]>,
): number[] {
  // Invert the mixture CDF on a fixed logit grid. Deterministic.
  const lo = logit(0.01), hi = logit(99.99);
  const steps = 800;
  const grid: number[] = [];
  for (let i = 0; i <= steps; i++) grid.push(lo + ((hi - lo) * i) / steps);
  const cdf = (x: number): number => {
    let s = 0;
    for (const [m, sd, w] of scenarios) {
      const z = (x - m) / Math.max(sd, 1e-6);
      // Normal CDF via erf approximation (Abramowitz-Stegun 7.1.26).
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      const phi = 1 - Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI) * poly;
      s += w * (z >= 0 ? phi : 1 - phi);
    }
    return s;
  };
  const out: number[] = [];
  for (const tau of LEVELS) {
    let best = grid[grid.length - 1];
    for (const x of grid) {
      if (cdf(x) >= tau) { best = x; break; }
    }
    out.push(round4(invLogit(best)));
  }
  // Enforce non-decreasing.
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1]);
  return out;
}

function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  const tAt = Date.parse(c.at);
  const tTarget = Date.parse(c.target);
  const horizonDays = Math.max(0, (tTarget - tAt) / 86400000);
  const horizonHours = Math.max(0, (tTarget - tAt) / 3600000);
  const reads = (c.history ?? []).slice().sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot));
  const last = reads[reads.length - 1];
  const nTrophies = c.trophies.length;

  // Distinct N values across reads: does the history show any growth?
  const ns = reads.map((r) => r.players_tracked);
  const nMin = Math.min(...ns), nMax = Math.max(...ns);
  const nVaries = nMax > nMin * 1.05;
  const ratesVary = reads.some((r) => r.rates.some((v, i) => Math.abs(v - last.rates[i]) > 1e-9));

  // --- Forecast N at target from log N linear in time (recent reads). ---
  // Launch-night reads are stale: the tracked population's mix changes
  // fast, so only the last 48h set the growth rate, and the slope is
  // capped (growth decelerates as the launch wave passes).
  function forecastN(): number {
    if (reads.length < 2 || !nVaries) return last.players_tracked;
    const cutoff = tAt - 48 * 3600000;
    const recent = reads.filter((r) => Date.parse(r.at) >= cutoff);
    const use = recent.length >= 3 ? recent : reads;
    const xs = use.map((r) => (Date.parse(r.at) - tAt) / 3600000);
    const ys = use.map((r) => Math.log(Math.max(1, r.players_tracked)));
    const [, b] = ols(xs, ys);
    const slope = Math.min(Math.max(b, 0), 0.15); // at most ~16%/hour, never shrinking
    const logN = Math.log(Math.max(1, last.players_tracked)) + slope * horizonHours;
    const cap = Math.log(Math.max(1, last.players_tracked)) + Math.log(15);
    return Math.exp(Math.min(logN, cap));
  }

  // Recent window for all per-trophy fits: the last 36h before the
  // checkpoint. Older reads describe a different player mix.
  const winCutoff = tAt - 36 * 3600000;
  const recentReads = reads.filter((r) => Date.parse(r.at) >= winCutoff);
  const fitReads = recentReads.length >= 5 ? recentReads : reads;
  // Hours since 2026-11-19T00:00Z, the regressor for the saturating trend
  // (logit rate linear in ln(1 + hours), as the house trend baseline does:
  // growth slows as the week goes on, it never runs away exponentially).
  const tRef = Date.parse("2026-11-19T00:00:00Z");
  const lnHours = (t: number): number => Math.log(1 + Math.max(0, (t - tRef) / 3600000));

  const nTarget = forecastN();
  const rows: Array<{ id: number; q: number[] }> = [];

  for (let i = 0; i < nTrophies; i++) {
    const rLast = last.rates[i];
    const id = c.trophies[i].id;

    // Platinum at 100% stays 100%; nothing to forecast.
    if (rLast >= 99.99) {
      rows.push({ id, q: [99.99, 99.99, 100, 100, 100].map((v) => round4(v)) });
      continue;
    }

    if (!nVaries && !ratesVary) {
      // ---- Flat history: stale page, a refresh may land before target. ----
      // Refresh branch: tracked players jump ~6x (launch night's refresh,
      // 638 -> 3,868 players, as the public rules describe it), earned
      // counts grow ~10% as the same players keep playing.
      const eLast = (rLast / 100) * last.players_tracked;
      const rRefresh = clampRate((100 * eLast * 1.1) / (last.players_tracked * 6));
      const wRefresh = 0.7;
      const medRefresh = logit(rRefresh);
      const medStay = logit(rLast);
      const spreadRefresh = 0.8;
      const spreadStay = 0.5 * Math.sqrt(Math.max(horizonDays, 0.001)) + 0.15;
      const q = quantileOfMixture([
        [medRefresh, spreadRefresh, wRefresh],
        [medStay, spreadStay, 1 - wRefresh],
      ]);
      rows.push({ id, q });
      continue;
    }

    // ---- History with variation: E(N) + saturating time-trend blend. ----
    // Both fits use only the recent window. The E(N) line's slope is the
    // marginal earn rate among newly tracked players; the trend is a
    // least-squares line of logit(rate) on ln(1 + hours since launch),
    // which saturates instead of exploding over a 4.5-day horizon.
    const eSeries = fitReads.map((r) => (r.rates[i] / 100) * r.players_tracked);
    const nSeries = fitReads.map((r) => r.players_tracked);
    const nDistinct = new Set(nSeries).size;
    const [aE, pE] = nDistinct >= 3 ? ols(nSeries, eSeries) : [eSeries[eSeries.length - 1], 0];
    const xsT = fitReads.map((r) => lnHours(Date.parse(r.at)));
    const ysT = fitReads.map((r) => logit(r.rates[i]));
    const [, bT, residT] = ols(xsT, ysT);
    const slopeT = Math.min(Math.max(bT, -0.6), 0.6); // per log-hour, clamped
    // Weight of the E(N) model by how much N varied inside the window.
    const wMax = Math.max(...nSeries), wMin = Math.min(...nSeries);
    const wN = 0.6 * Math.min(1, Math.log(Math.max(1, wMax / Math.max(1, wMin))) / Math.log(2));
    // E(N) forecast rate at the forecast N.
    const eN = Math.max(0, aE + pE * nTarget);
    const rN = nDistinct >= 3 ? clampRate((100 * eN) / Math.max(1, nTarget)) : rLast;
    // Saturating trend forecast rate, change from the last rate clamped.
    const dTrend = Math.min(2, Math.max(-2, slopeT * (lnHours(tTarget) - lnHours(tAt))));
    const rT = invLogit(logit(rLast) + dTrend);
    const medLogit = (1 - wN) * logit(rT) + wN * logit(rN);
    // Spread: fit residual + random-walk growth with horizon + floor.
    const spread = Math.min(1.8, Math.max(0.6, Math.sqrt(Math.max(residT, 0.04) ** 2 + 0.25 * horizonDays + 0.09)));
    const q = Z.map((z) => round4(invLogit(medLogit + z * spread)));
    for (let k = 1; k < q.length; k++) q[k] = Math.max(q[k], q[k - 1]);
    rows.push({ id, q });
  }
  return { trophies: rows };
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(inDir).filter((f) => f.endsWith(".in")).sort();
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(inDir, f), "utf8")) as Case;
    const out = forecastCase(c);
    const outName = f.replace(/\.in$/, ".out");
    fs.writeFileSync(path.join(outDir, outName), JSON.stringify(out));
  }
}

main();
