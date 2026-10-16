/** Small seeded PRNG (mulberry32) so agents regenerate identically from a seed. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  /** Restart the stream from a new seed (Living City: one stream per agent, no allocation). */
  reseed(seed: number): void {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Standard normal via Box–Muller. */
  normal(): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Uniform random point in a disc of radius r around (x, y). */
export function pointInDisc(rng: Rng, x: number, y: number, r: number): [number, number] {
  const a = rng.next() * Math.PI * 2;
  const d = Math.sqrt(rng.next()) * r;
  return [x + Math.cos(a) * d, y + Math.sin(a) * d];
}

// ---------------------------------------------------------------------------
// Stateless seeded streams (city chaos): every draw comes from a fresh Rng(hashSeed(...)), so any
// day can be computed on the main thread or in the worker with no history.

/** Hash of integer parts (FNV-1a with a murmur-style finaliser per part). Never 0. */
export function hashSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0 || 1;
}

/** Poisson draw: Knuth's method for λ ≤ 30, a rounded normal approximation above. Never negative. */
export function poisson(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.normal()));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  for (;;) {
    p *= rng.next();
    if (p <= L) return k;
    k++;
  }
}

/** Symmetric triangular draw on [a, b] (mean (a + b) / 2). */
export function triangular(rng: Rng, a: number, b: number): number {
  return a + ((b - a) * (rng.next() + rng.next())) / 2;
}

/** floor(x), plus one with probability frac(x). */
export function stochasticRound(rng: Rng, x: number): number {
  const n = Math.floor(x);
  return rng.next() < x - n ? n + 1 : n;
}

/** The value of a [value, weight] pair picked with u ∈ [0, 1). */
export function pickWeighted(pairs: readonly (readonly [number, number])[], u: number): number {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let acc = 0;
  const target = u * total;
  for (const [v, w] of pairs) {
    acc += w;
    if (target < acc) return v;
  }
  return pairs[pairs.length - 1][0];
}

// ---------------------------------------------------------------------------
// Living City: identity hashes (no allocation, so they can run once per agent).

/** One murmur3 block: mix a 32-bit word into the running hash. */
function mm3(h: number, k: number): number {
  k = Math.imul(k | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/**
 * Hash of four integers (murmur3-32 over the four words with its finaliser): e.g. the seed of agent
 * k of group (home, work, band). Unsigned 32-bit; may be 0 (Rng maps a 0 seed to 1).
 */
export function hash32x4(a: number, b: number, c: number, d: number): number {
  let h = 0x9747b28c;
  h = mm3(h, a);
  h = mm3(h, b);
  h = mm3(h, c);
  h = mm3(h, d);
  h ^= 16;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over bytes, chainable through `h` (Living City growth fingerprint). Unsigned 32-bit. */
export function fnv32(bytes: Uint8Array, h = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}
