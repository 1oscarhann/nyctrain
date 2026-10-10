/**
 * Train kinematics shared by the timetable builder and the simulation.
 */

/** Distance to stop from speed v with deceleration b. */
export function brakingDistance(v: number, b: number): number {
  return (v * v) / (2 * b);
}

/** Highest speed from which a train can still stop (or slow to vEnd) within distance d. */
export function maxApproachSpeed(d: number, b: number, vEnd = 0): number {
  return Math.sqrt(Math.max(0, vEnd * vEnd + 2 * b * Math.max(0, d)));
}

export interface SpeedLimit {
  s0: number;
  s1: number;
  v: number;
}

export interface RunProfile {
  /** Scheduled arrival time at each stop, seconds from leaving the first stop. */
  arrive: number[];
  /** Scheduled departure time from each stop. */
  depart: number[];
  /** Running time between consecutive stops (excluding dwell). */
  legTime: number[];
  total: number;
}

/**
 * Fastest run along a path: accelerate, cruise at the lower of top speed and the curve limit,
 * brake to stop at each station and before slower sections. Computed with a forward/backward
 * pass on a fine distance grid.
 */
export function runProfile(
  length: number,
  limits: SpeedLimit[],
  stops: number[],
  accel: number,
  brake: number,
  vmax: number,
  dwell: number,
): RunProfile {
  const ds = 5;
  const n = Math.max(2, Math.ceil(length / ds) + 1);
  const step = length / (n - 1);
  const cap = new Float64Array(n).fill(vmax);
  for (const l of limits) {
    const i0 = Math.max(0, Math.floor(l.s0 / step));
    const i1 = Math.min(n - 1, Math.ceil(l.s1 / step));
    for (let i = i0; i <= i1; i++) if (l.v < cap[i]) cap[i] = l.v;
  }
  const stopIdx = stops.map((s) => Math.max(0, Math.min(n - 1, Math.round(s / step))));
  for (const i of stopIdx) cap[i] = 0;
  const v = new Float64Array(n);
  // Forward: acceleration limit.
  v[0] = 0;
  for (let i = 1; i < n; i++) v[i] = Math.min(cap[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * accel * step));
  // Backward: braking limit.
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * brake * step));
  // Time at each grid point.
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const avg = (v[i] + v[i - 1]) / 2;
    t[i] = t[i - 1] + (avg > 1e-3 ? step / avg : Math.sqrt((2 * step) / Math.max(accel, 1e-3)));
  }
  const arrive: number[] = [];
  const depart: number[] = [];
  const legTime: number[] = [];
  let extra = 0;
  stopIdx.forEach((i, k) => {
    const a = t[i] + extra;
    arrive.push(a);
    if (k > 0) legTime.push(t[i] - t[stopIdx[k - 1]]);
    const d = k > 0 && k < stopIdx.length - 1 ? dwell : 0;
    extra += d;
    depart.push(a + d);
  });
  return { arrive, depart, legTime, total: arrive[arrive.length - 1] ?? 0 };
}
