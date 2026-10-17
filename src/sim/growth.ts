/**
 * Living City (v2): transit-oriented growth and value capture (docs/v2/living-city.md §3).
 *
 * Once a month the worker measures each tract's commute benefit (Commuters.commuteBenefit) and
 * calls Growth.step: residents and jobs grow toward well-served tracts, the OD matrix is rebalanced
 * by Furness factors (OD'[h][w] = OD[h][w]·fHome[h]·fWork[w], so tract sums match the grown
 * targets), the land-value premium capitalises, and the value-capture district pays its share of
 * the tax increment. Pure arithmetic: no RNG, fixed index order, and every stored Float32 value is
 * canonicalised with Math.fround, so a live worker and a reloaded one hold bit-identical state.
 * Runs in the worker and in Node.
 */
import { GROWTH, VALUE_CAPTURE, type GrowthPace, type GrowthSide } from '../balance';
import { monthLabel } from '../core/calendar';
import { fnv32 } from '../core/rng';
import type { World } from '../data/world';
import type { Boomtown, CompiledNetwork, GrowthCityPoint, GrowthData, GrowthMonth, GrowthSnapshot, GrowthView, TractGrowth } from './protocol';

export interface StationPt {
  id: number;
  x: number;
  y: number;
}

/** What agent generation needs: the Furness factors and a tag for the ModeState key. */
export interface OdFactors {
  home: Float32Array;
  work: Float32Array;
  tag: string;
}

/** Per-tract commute benefit in minutes (Commuters.commuteBenefit), and optionally the city mean. */
export interface Benefits {
  home: ArrayLike<number>;
  work: ArrayLike<number>;
  mean?: number;
}

export interface ValueCaptureResult {
  /** This month's payment to the authority (city currency). */
  total: number;
  /** Assessed value increment over the start, district share only (city currency). */
  increment: number;
  /** Levy by served station id (each tract pays through its nearest served station). */
  byStation: Record<number, number>;
  /** 1 where any part of the tract is in the district. */
  district: Uint8Array;
  /** Share of the tract's area within VALUE_CAPTURE.districtRadius of a served station (0 … 1). */
  share: Float32Array;
  /** Monthly levy per tract. */
  levy: Float64Array;
  /** Index (into the served list) of each district tract's nearest served station (−1 outside the district). */
  nearest: Int32Array;
  /** Tracts with district > 0. */
  tracts: number;
}

/** Sample points per tract for district shares (a Vogel spiral fills the tract's disc evenly). */
export const DISTRICT_SAMPLES = 64;
const SAMPLE_X = new Float64Array(DISTRICT_SAMPLES);
const SAMPLE_Y = new Float64Array(DISTRICT_SAMPLES);
for (let k = 0; k < DISTRICT_SAMPLES; k++) {
  const rho = Math.sqrt((k + 0.5) / DISTRICT_SAMPLES);
  const th = k * 2.399963229728653; // golden angle
  SAMPLE_X[k] = rho * Math.cos(th);
  SAMPLE_Y[k] = rho * Math.sin(th);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Attractiveness 0 … 1 of a commute benefit (minutes): b / (b + GROWTH.halfBenefit). */
export function attractiveness(benefitMinutes: number): number {
  return benefitMinutes > 0 ? benefitMinutes / (benefitMinutes + GROWTH.halfBenefit) : 0;
}

/**
 * Stations that some running route stops at (in compiled order). A built station no route serves
 * creates no district, so stub stations cannot farm growth.
 */
export function servedStations(net: CompiledNetwork | null): StationPt[] {
  if (!net) return [];
  const used = new Uint8Array(net.stations.length);
  for (const r of net.routes) {
    if (!(r.fleet > 0) || !r.headways.some((h) => h > 0)) continue;
    for (const d of r.dirs) for (let k = 0; k < d.stopStation.length; k++) used[d.stopStation[k]] = 1;
  }
  const out: StationPt[] = [];
  net.stations.forEach((s, i) => {
    if (!used[i]) return;
    // Four-track sections (v2): a cross-platform pair is one station complex. It is listed once,
    // under its lower station id at the platforms' midpoint, when either platform is served (a
    // platform no route calls at is never served: skipping stations is just leaving them out of
    // the stop list).
    const j = s.pair;
    if (j !== undefined && j >= 0 && net.stations[j]) {
      if (used[j] && j < i) return;
      const p = net.stations[j];
      out.push({ id: Math.min(s.id, p.id), x: (s.x + p.x) / 2, y: (s.y + p.y) / 2 });
      return;
    }
    out.push({ id: s.id, x: s.x, y: s.y });
  });
  return out;
}

/** Monthly natural growth rate (before the pace multiplier). */
function baseRate(): number {
  return (1 + GROWTH.cityGrowthPerYear) ** (1 / 12) - 1;
}

/** The boost fades linearly to 0 as a tract approaches its long-run maximum (1 at the start). */
function roomUp(m: number, P: GrowthSide): number {
  return clamp01((P.maxMultiple - m) / (P.maxMultiple - 1));
}

/** The relocation drain fades linearly to 0 as a tract approaches its long-run minimum. */
function roomDown(m: number, P: GrowthSide): number {
  return clamp01((m - P.minMultiple) / (1 - P.minMultiple));
}

/**
 * One tract's monthly growth rate on one side: the city's natural growth (exact, undamped), plus
 * the boost for its attractiveness (fading toward the long-run maximum), minus the city-wide
 * relocation drain (relocationShare of the boost actually realised, `sbar` per person, fading
 * toward the long-run minimum). The pace multiplier scales it all before the monthly caps.
 */
function sideRate(m: number, s: number, sbar: number, P: GrowthSide, k: number, gBase: number): number {
  const d = P.boostPerMonth * (s * roomUp(m, P) - P.relocationShare * sbar * roomDown(m, P));
  const r = k * (gBase + d);
  return Math.max(-k * P.maxDeclinePerMonth, Math.min(k * P.maxGrowthPerMonth, r));
}

/**
 * Water-filling: scale the free entries of `next` so that Σ next = total, clamping to [lo, hi] and
 * fixing clamped entries until none move. Entries with hi ≤ lo are fixed from the start.
 */
export function fitTotal(next: Float64Array, lo: Float64Array, hi: Float64Array, total: number): void {
  const n = next.length;
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!(hi[i] > lo[i])) fixed[i] = 1;
  for (let pass = 0; pass < 64; pass++) {
    let sumFixed = 0, sumFree = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) sumFixed += next[i];
      else sumFree += next[i];
    }
    if (!(sumFree > 0)) return;
    const f = (total - sumFixed) / sumFree;
    if (f === 1) return;
    let clamped = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const v = next[i] * f;
      if (v > hi[i]) {
        next[i] = hi[i];
        fixed[i] = 1;
        clamped = true;
      } else if (v < lo[i]) {
        next[i] = lo[i];
        fixed[i] = 1;
        clamped = true;
      } else next[i] = v;
    }
    if (!clamped) return;
  }
}

/** Remove snapshots until at most `max` remain: each time the one whose removal leaves the smallest gap (oldest first); the first and last are kept. */
function thin<T extends { day: number }>(list: T[], max: number): void {
  while (list.length > max && list.length > 2) {
    let best = 1, gap = Infinity;
    for (let i = 1; i < list.length - 1; i++) {
      const g = list[i + 1].day - list[i - 1].day;
      if (g < gap) {
        gap = g;
        best = i;
      }
    }
    list.splice(best, 1);
  }
}

export class Growth {
  readonly T: number;
  pace: GrowthPace;
  mRes: Float32Array;
  mJobs: Float32Array;
  fHome: Float32Array;
  fWork: Float32Array;
  premium: Float32Array;
  appliedThroughDay = -1;
  months = 0;
  sbar: [number, number] = [0, 0];
  history: GrowthSnapshot[] = [];
  city: GrowthCityPoint[] = [];
  /**
   * The month's commute benefits so far: one sample per weekday (the engine adds one at each
   * midnight while the pace is on, accumulateBenefit), averaged at the month close (monthBenefit)
   * and cleared after it. So one bad-weather or incident-hit day moves a month's growth by about
   * 1/21 of its effect, not all of it. Sums in Float64, saved exactly.
   */
  benefitDays = 0;
  /** Last day sampled (−1 = none): a day is sampled once, so a reload never samples it again. */
  benefitThroughDay = -1;
  benefitHome: Float64Array;
  benefitWork: Float64Array;
  benefitMeanSum = 0;
  /** Starting residents and jobs per tract (the OD row and column sums, which equal tracts.json's). */
  readonly R0: Float64Array;
  readonly J0: Float64Array;
  /** Starting commuters (Σ R0 = Σ J0). */
  readonly total0: number;
  /** fromData was given state that does not fit this world (tract count changed): it starts over. */
  dropped = false;
  private readonly tx: Float64Array;
  private readonly ty: Float64Array;
  private readonly tr: Float64Array;
  private readonly odHome: Uint16Array;
  private readonly odWork: Uint16Array;
  /** All bands of each OD pair. */
  private readonly tot: Float32Array;

  constructor(world: World, pace: GrowthPace = GROWTH.defaultPace) {
    const T = world.tracts.length;
    this.T = T;
    this.pace = pace;
    const od = world.od;
    const n = od.pairCount;
    this.odHome = od.home;
    this.odWork = od.work;
    this.tot = new Float32Array(n);
    const R0 = new Float64Array(T), J0 = new Float64Array(T);
    for (let p = 0; p < n; p++) {
      const c = od.counts[0][p] + od.counts[1][p] + od.counts[2][p];
      this.tot[p] = c;
      R0[od.home[p]] += c;
      J0[od.work[p]] += c;
    }
    this.R0 = R0;
    this.J0 = J0;
    let t0 = 0;
    for (let i = 0; i < T; i++) t0 += R0[i];
    this.total0 = t0;
    this.tx = Float64Array.from(world.tracts, (t) => t.x);
    this.ty = Float64Array.from(world.tracts, (t) => t.y);
    this.tr = Float64Array.from(world.tracts, (t) => t.radius);
    this.mRes = new Float32Array(T).fill(1);
    this.mJobs = new Float32Array(T).fill(1);
    this.fHome = new Float32Array(T).fill(1);
    this.fWork = new Float32Array(T).fill(1);
    this.premium = new Float32Array(T);
    this.benefitHome = new Float64Array(T);
    this.benefitWork = new Float64Array(T);
  }

  /** State from a save (or identity when null). State that does not fit the world is dropped (dropped = true). */
  static fromData(world: World, d: GrowthData | null | undefined, pace: GrowthPace = GROWTH.defaultPace): Growth {
    const g = new Growth(world, pace);
    if (!d) return g;
    const T = g.T;
    const ok =
      d.version === 1 &&
      [d.mRes, d.mJobs, d.fHome, d.fWork, d.premium].every((a) => a instanceof Float32Array && a.length === T) &&
      Array.isArray(d.history) &&
      d.history.every((h) => h.q instanceof Uint16Array && h.q.length === 2 * T) &&
      Array.isArray(d.city) &&
      Number.isFinite(d.months) &&
      Number.isFinite(d.appliedThroughDay);
    if (!ok) {
      g.dropped = true;
      return g;
    }
    g.mRes.set(d.mRes);
    g.mJobs.set(d.mJobs);
    g.fHome.set(d.fHome);
    g.fWork.set(d.fWork);
    g.premium.set(d.premium);
    g.appliedThroughDay = d.appliedThroughDay;
    g.months = d.months;
    g.sbar = [d.sbar?.[0] ?? 0, d.sbar?.[1] ?? 0];
    g.history = d.history.map((h) => ({ day: h.day, q: h.q.slice() }));
    g.city = d.city.map((c) => ({ ...c }));
    // The month's benefit samples: kept only when they fit (otherwise the month averages the days from now on).
    const bs = d.benefit;
    if (
      bs &&
      bs.home instanceof Float64Array &&
      bs.home.length === T &&
      bs.work instanceof Float64Array &&
      bs.work.length === T &&
      [bs.days, bs.throughDay, bs.meanSum].every(Number.isFinite)
    ) {
      g.benefitDays = bs.days;
      g.benefitThroughDay = bs.throughDay;
      g.benefitMeanSum = bs.meanSum;
      g.benefitHome.set(bs.home);
      g.benefitWork.set(bs.work);
    }
    return g;
  }

  /** A structured-clone-safe copy of the state. */
  toData(): GrowthData {
    return {
      version: 1,
      appliedThroughDay: this.appliedThroughDay,
      months: this.months,
      mRes: this.mRes.slice(),
      mJobs: this.mJobs.slice(),
      fHome: this.fHome.slice(),
      fWork: this.fWork.slice(),
      premium: this.premium.slice(),
      sbar: [this.sbar[0], this.sbar[1]],
      history: this.history.map((h) => ({ day: h.day, q: h.q.slice() })),
      city: this.city.map((c) => ({ ...c })),
      ...(this.benefitDays > 0
        ? { benefit: { days: this.benefitDays, throughDay: this.benefitThroughDay, meanSum: this.benefitMeanSum, home: this.benefitHome.slice(), work: this.benefitWork.slice() } }
        : {}),
    };
  }

  /** Something a save must carry: a grown city, or this month's benefit samples. */
  hasState(): boolean {
    return this.months > 0 || this.benefitDays > 0;
  }

  /** Add one day's commute benefits to the month's samples (once per day; false when `day` was already sampled). */
  accumulateBenefit(day: number, b: Benefits): boolean {
    if (day <= this.benefitThroughDay) return false;
    for (let i = 0; i < this.T; i++) {
      this.benefitHome[i] += b.home[i] ?? 0;
      this.benefitWork[i] += b.work[i] ?? 0;
    }
    this.benefitMeanSum += b.mean ?? meanBenefit(b.home, this.currentResidents());
    this.benefitDays++;
    this.benefitThroughDay = day;
    return true;
  }

  /** The month's mean commute benefits (null before any sample). */
  monthBenefit(): Benefits | null {
    const n = this.benefitDays;
    if (!(n > 0)) return null;
    return { home: this.benefitHome.map((v) => v / n), work: this.benefitWork.map((v) => v / n), mean: this.benefitMeanSum / n };
  }

  /** A month closed (or was skipped on pace Off): the next month starts its samples afresh. */
  resetBenefit(): void {
    this.benefitDays = 0;
    this.benefitMeanSum = 0;
    this.benefitHome.fill(0);
    this.benefitWork.fill(0);
  }

  /** The starting city: no month has been applied (OD' = OD, agents exactly as before Living City). */
  isIdentity(): boolean {
    return this.months === 0;
  }

  /** '' for the starting city, else `g<months>:<fnv32 of fHome and fWork, hex>` (ModeState key suffix). */
  fingerprint(): string {
    if (this.months === 0) return '';
    const h = fnv32(bytesOf(this.fWork), fnv32(bytesOf(this.fHome)));
    return `g${this.months}:${h.toString(16)}`;
  }

  /** The OD factors for agent generation; null for the starting city (keeps the pre-Living City key). Read-only views of live state. */
  factors(): OdFactors | null {
    if (this.months === 0) return null;
    return { home: this.fHome, work: this.fWork, tag: this.fingerprint() };
  }

  setPace(p: GrowthPace): void {
    this.pace = p;
  }

  /** Current target residents / jobs of a tract (real people). */
  residents(i: number): number {
    return this.R0[i] * this.mRes[i];
  }

  jobs(i: number): number {
    return this.J0[i] * this.mJobs[i];
  }

  /** Current target residents of every tract (e.g. weights for event-goers' origins). */
  currentResidents(): Float64Array {
    const out = new Float64Array(this.T);
    for (let i = 0; i < this.T; i++) out[i] = this.R0[i] * this.mRes[i];
    return out;
  }

  /** Σ OD' per home and per work tract (tests and diagnostics). */
  odSums(): { home: Float64Array; work: Float64Array } {
    const home = new Float64Array(this.T), work = new Float64Array(this.T);
    const { odHome, odWork, tot, fHome, fWork } = this;
    for (let p = 0; p < tot.length; p++) {
      const v = tot[p] * fHome[odHome[p]] * fWork[odWork[p]];
      home[odHome[p]] += v;
      work[odWork[p]] += v;
    }
    return { home, work };
  }

  /**
   * Close a growth month on `day` (the month's last weekday): grow residents and jobs from the
   * benefits, rebalance the OD factors, capitalise the land-value premium and compute the month's
   * value capture. Returns null (state unchanged) on pace Off or when `day` was already applied.
   */
  step(day: number, b: Benefits, served: readonly StationPt[]): GrowthMonth | null {
    const k = GROWTH.paceMultiplier[this.pace] ?? 0;
    if (!(k > 0) || day <= this.appliedThroughDay) return null;
    const T = this.T;
    const sR = new Float64Array(T), sJ = new Float64Array(T);
    for (let i = 0; i < T; i++) {
      sR[i] = attractiveness(b.home[i]);
      sJ[i] = attractiveness(b.work[i]);
    }
    const Rc = new Float64Array(T), Jc = new Float64Array(T);
    for (let i = 0; i < T; i++) {
      Rc[i] = this.R0[i] * this.mRes[i];
      Jc[i] = this.J0[i] * this.mJobs[i];
    }
    const gBase = baseRate();
    const pr = proposal(Rc, this.mRes, this.R0, sR, GROWTH.residents, k, gBase);
    const pj = proposal(Jc, this.mJobs, this.J0, sJ, GROWTH.jobs, k, gBase);
    // Residents ≡ jobs ≡ commuters: one common total, within both sides' monthly bounds and the city cap.
    let total = Math.min(GROWTH.cityMaxMultiple * this.total0, (pr.sum + pj.sum) / 2);
    total = Math.max(total, Math.max(pr.sumLo, pj.sumLo));
    total = Math.min(total, Math.min(pr.sumHi, pj.sumHi));
    fitTotal(pr.next, pr.lo, pr.hi, total);
    fitTotal(pj.next, pj.lo, pj.hi, total);
    for (let i = 0; i < T; i++) {
      this.mRes[i] = this.R0[i] > 0 ? Math.fround(pr.next[i] / this.R0[i]) : 1;
      this.mJobs[i] = this.J0[i] > 0 ? Math.fround(pj.next[i] / this.J0[i]) : 1;
    }
    this.furness(GROWTH.balanceIterations);
    this.updatePremium(sR, sJ, k);
    const vc = this.valueCapture(served);
    const report = this.buildReport(day, Rc, Jc, vc, b, GROWTH.boomtownMinNaturalMultiple * k * gBase);
    this.history.push(this.snapshot(day));
    thin(this.history, GROWTH.historyMax);
    this.city.push({ day, residents: report.residents, jobs: report.jobs, valueCapture: vc.total });
    thin(this.city, GROWTH.cityMax);
    this.sbar = [pr.sbar, pj.sbar];
    this.appliedThroughDay = day;
    this.months++;
    return report;
  }

  /** Furness / IPF, warm-started from the current factors: K passes, columns exact after each. */
  furness(K: number): void {
    const T = this.T;
    const { odHome, odWork, tot, fHome, fWork } = this;
    const n = tot.length;
    const row = new Float64Array(T), col = new Float64Array(T);
    for (let it = 0; it < K; it++) {
      row.fill(0);
      for (let p = 0; p < n; p++) row[odHome[p]] += tot[p] * fWork[odWork[p]];
      for (let h = 0; h < T; h++) if (row[h] > 0) fHome[h] = Math.fround((this.R0[h] * this.mRes[h]) / row[h]);
      col.fill(0);
      for (let p = 0; p < n; p++) col[odWork[p]] += tot[p] * fHome[odHome[p]];
      for (let w = 0; w < T; w++) if (col[w] > 0) fWork[w] = Math.fround((this.J0[w] * this.mJobs[w]) / col[w]);
    }
  }

  /** The premium moves part of the way (premiumLagPerMonth, compounded by the pace) toward premiumMax × value-weighted attractiveness. */
  private updatePremium(sR: Float64Array, sJ: Float64Array, k: number): void {
    const V = VALUE_CAPTURE;
    const lag = 1 - (1 - V.premiumLagPerMonth) ** k;
    for (let i = 0; i < this.T; i++) {
      const vr = V.valuePerResident * this.R0[i] * this.mRes[i];
      const vj = V.valuePerJob * this.J0[i] * this.mJobs[i];
      const s = (vr * sR[i] + vj * sJ[i]) / (vr + vj || 1);
      const p = this.premium[i];
      this.premium[i] = Math.fround(p + lag * (V.premiumMax * s - p));
    }
  }

  /**
   * Value capture at current values (pure; month close and the panels' projection): every tract
   * pays, for the share of its area within districtRadius of a served station, captureShare of the
   * monthly tax on its value increment over the start (homes and workplaces at their own effective
   * rates, floored at 0 per tract). New development and the premium both count.
   */
  valueCapture(served: readonly StationPt[]): ValueCaptureResult {
    const T = this.T;
    const V = VALUE_CAPTURE;
    const R = V.districtRadius;
    const district = new Uint8Array(T);
    const share = new Float32Array(T);
    const levy = new Float64Array(T);
    const nearest = new Int32Array(T).fill(-1);
    const byStation: Record<number, number> = {};
    let total = 0, increment = 0, tracts = 0;
    const S = served.length;
    if (S === 0) return { total, increment, byStation, district, share, levy, nearest, tracts };
    // Stations bucketed on a 1 km grid; each tract scans only the cells within reach.
    const CELL = 1000;
    const grid = new Map<number, number[]>();
    const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
    for (let j = 0; j < S; j++) {
      const k = cellKey(Math.floor(served[j].x / CELL), Math.floor(served[j].y / CELL));
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(j);
    }
    const cand: number[] = [];
    const rate = V.captureShare / 12;
    for (let i = 0; i < T; i++) {
      const x = this.tx[i], y = this.ty[i], r = this.tr[i];
      const reach = R + r;
      cand.length = 0;
      let best = -1, bestD = Infinity, full = false;
      const cx0 = Math.floor((x - reach) / CELL), cx1 = Math.floor((x + reach) / CELL);
      const cy0 = Math.floor((y - reach) / CELL), cy1 = Math.floor((y + reach) / CELL);
      for (let cx = cx0; cx <= cx1; cx++)
        for (let cy = cy0; cy <= cy1; cy++) {
          const arr = grid.get(cellKey(cx, cy));
          if (!arr) continue;
          for (const j of arr) {
            const d = Math.hypot(served[j].x - x, served[j].y - y);
            if (d > reach) continue;
            cand.push(j);
            if (d + r <= R) full = true;
            // Nearest within reach (ties: the lower index, independent of the scan order).
            if (d < bestD || (d === bestD && j < best)) {
              bestD = d;
              best = j;
            }
          }
        }
      nearest[i] = best;
      if (!cand.length) continue;
      let sh = 1;
      if (!full) {
        let inside = 0;
        for (let k = 0; k < DISTRICT_SAMPLES; k++) {
          const px = x + r * SAMPLE_X[k], py = y + r * SAMPLE_Y[k];
          for (const j of cand) {
            const dx = served[j].x - px, dy = served[j].y - py;
            if (dx * dx + dy * dy <= R * R) {
              inside++;
              break;
            }
          }
        }
        sh = inside / DISTRICT_SAMPLES;
      }
      if (sh <= 0) continue;
      district[i] = 1;
      share[i] = sh;
      tracts++;
      const p = 1 + this.premium[i];
      const h0 = V.valuePerResident * this.R0[i], j0 = V.valuePerJob * this.J0[i];
      const dh = h0 * this.mRes[i] * p - h0, dj = j0 * this.mJobs[i] * p - j0;
      const taxInc = Math.max(0, V.taxRateHomes * dh + V.taxRateJobs * dj);
      const l = rate * sh * taxInc;
      levy[i] = l;
      total += l;
      increment += sh * Math.max(0, dh + dj);
      const id = served[best].id;
      byStation[id] = (byStation[id] ?? 0) + l;
    }
    return { total, increment, byStation, district, share, levy, nearest, tracts };
  }

  /** The growth overlay's data (copies). */
  view(served: readonly StationPt[]): GrowthView {
    const vc = this.valueCapture(served);
    const stationTracts: Record<number, number> = {};
    for (let i = 0; i < this.T; i++) {
      if (vc.district[i] !== 1 || vc.nearest[i] < 0) continue;
      const id = served[vc.nearest[i]].id;
      stationTracts[id] = (stationTracts[id] ?? 0) + 1;
    }
    return {
      months: this.months,
      mRes: this.mRes.slice(),
      mJobs: this.mJobs.slice(),
      premium: this.premium.slice(),
      district: vc.district,
      districtShare: vc.share,
      stationLevy: vc.byStation,
      stationTracts,
      projectedValueCapture: this.pace === 'off' ? 0 : vc.total,
      city: this.city.map((c) => ({ ...c })),
    };
  }

  /** One tract for the tract panel; `b` is the live commute benefit (Commuters.commuteBenefit). */
  tract(i: number, served: readonly StationPt[], b: Benefits): TractGrowth {
    const vc = this.valueCapture(served);
    const T = this.T;
    const k = GROWTH.paceMultiplier[this.pace] ?? 0;
    const gBase = baseRate();
    const bh = b.home[i] ?? 0, bw = b.work[i] ?? 0;
    let near = -1, nearD = Infinity;
    for (let j = 0; j < served.length; j++) {
      const d = Math.hypot(served[j].x - this.tx[i], served[j].y - this.ty[i]);
      if (d < nearD) {
        nearD = d;
        near = j;
      }
    }
    return {
      residents0: this.R0[i],
      jobs0: this.J0[i],
      residents: this.residents(i),
      jobs: this.jobs(i),
      history: this.history.map((h) => ({ day: h.day, residents: (this.R0[i] * h.q[i]) / 10000, jobs: (this.J0[i] * h.q[T + i]) / 10000 })),
      benefitHome: bh,
      benefitWork: bw,
      cityBenefit: b.mean ?? meanBenefit(b.home, this.currentResidents()),
      projectedRateRes: k > 0 && this.R0[i] > 0 ? sideRate(this.mRes[i], attractiveness(bh), this.sbar[0], GROWTH.residents, k, gBase) : 0,
      projectedRateJobs: k > 0 && this.J0[i] > 0 ? sideRate(this.mJobs[i], attractiveness(bw), this.sbar[1], GROWTH.jobs, k, gBase) : 0,
      premium: this.premium[i],
      inDistrict: vc.district[i] === 1,
      districtShare: vc.share[i],
      nearestStation: near >= 0 ? served[near].id : null,
      levy: this.pace === 'off' ? 0 : vc.levy[i],
    };
  }

  private snapshot(day: number): GrowthSnapshot {
    const T = this.T;
    const q = new Uint16Array(2 * T);
    for (let i = 0; i < T; i++) {
      q[i] = Math.min(65535, Math.round(this.mRes[i] * 10000));
      q[T + i] = Math.min(65535, Math.round(this.mJobs[i] * 10000));
    }
    return { day, q };
  }

  /** The month report; `boomRate`: the lowest monthly rate (residents + jobs) listed as a boomtown. */
  private buildReport(day: number, Rc: Float64Array, Jc: Float64Array, vc: ValueCaptureResult, b: Benefits, boomRate: number): GrowthMonth {
    const T = this.T;
    let res = 0, jobs = 0, res0 = 0, jobs0 = 0;
    const boom: Boomtown[] = [];
    const miles: { tract: number; pct: number; people: number }[] = [];
    let maxTractGrowth = 0;
    for (let i = 0; i < T; i++) {
      const rn = this.residents(i), jn = this.jobs(i);
      res += rn;
      jobs += jn;
      res0 += Rc[i];
      jobs0 += Jc[i];
      const base = this.R0[i] + this.J0[i];
      if (base < GROWTH.minTractPeople) continue;
      const before = (Rc[i] + Jc[i]) / base - 1;
      const after = (rn + jn) / base - 1;
      if (after > maxTractGrowth) maxTractGrowth = after;
      const rate = (rn + jn) / (Rc[i] + Jc[i]) - 1;
      if (rate > 0 && rate >= boomRate) boom.push({ tract: i, rate, dRes: rn - Rc[i], dJobs: jn - Jc[i], sinceStart: after });
      for (const th of GROWTH.milestonesUp) if (before < th && after >= th) miles.push({ tract: i, pct: th, people: base });
      for (const th of GROWTH.milestonesDown) if (before > th && after <= th) miles.push({ tract: i, pct: th, people: base });
    }
    boom.sort((a, c) => c.rate - a.rate || a.tract - c.tract);
    // Biggest milestones first, growth before decline, then the bigger tract.
    miles.sort((a, c) => Math.abs(c.pct) - Math.abs(a.pct) || c.pct - a.pct || c.people - a.people || a.tract - c.tract);
    return {
      day,
      label: monthLabel(day),
      pace: this.pace,
      residents: res,
      jobs,
      dResidents: res - res0,
      dJobs: jobs - jobs0,
      agents: 0,
      commuters: 0,
      valueCapture: vc.total,
      districtTracts: vc.tracts,
      districtIncrement: vc.increment,
      stationLevy: vc.byStation,
      benefitMean: b.mean ?? meanBenefit(b.home, Rc),
      boomtowns: boom.slice(0, GROWTH.boomtownsInReport),
      milestones: miles.slice(0, GROWTH.milestonesInReport).map(({ tract, pct }) => ({ tract, pct })),
      maxTractGrowth,
    };
  }
}

/**
 * One side's proposal: next values within this month's bounds [lo, hi], and `sbar`, the people-
 * weighted mean of the attractiveness that can still turn into growth (s × roomUp), which sets the
 * relocation drain: a city whose best tracts are full stops draining the rest.
 */
function proposal(cur: Float64Array, m: Float32Array, base: Float64Array, s: Float64Array, P: GrowthSide, k: number, gBase: number) {
  const T = cur.length;
  let tot = 0, sw = 0;
  for (let i = 0; i < T; i++) {
    tot += cur[i];
    sw += cur[i] * s[i] * roomUp(m[i], P);
  }
  const sbar = tot > 0 ? sw / tot : 0;
  const next = new Float64Array(T), lo = new Float64Array(T), hi = new Float64Array(T);
  let sum = 0, sumLo = 0, sumHi = 0;
  for (let i = 0; i < T; i++) {
    if (!(base[i] > 0)) continue; // e.g. New York's 20 zero-job tracts stay at 0
    const c = cur[i];
    const r = sideRate(m[i], s[i], sbar, P, k, gBase);
    const l = Math.min(c, Math.max(P.minMultiple * base[i], c * (1 - k * P.maxDeclinePerMonth)));
    const h = Math.max(c, Math.min(P.maxMultiple * base[i], c * (1 + k * P.maxGrowthPerMonth)));
    const v = c * (1 + r);
    next[i] = v < l ? l : v > h ? h : v;
    lo[i] = l;
    hi[i] = h;
    sum += next[i];
    sumLo += l;
    sumHi += h;
  }
  return { next, lo, hi, sbar, sum, sumLo, sumHi };
}

/** Residents-weighted mean of the home benefit (when the caller has no agent-weighted mean). */
function meanBenefit(home: ArrayLike<number>, residents: Float64Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < residents.length; i++) {
    s += residents[i] * (home[i] ?? 0);
    n += residents[i];
  }
  return n > 0 ? s / n : 0;
}

function bytesOf(a: Float32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}
