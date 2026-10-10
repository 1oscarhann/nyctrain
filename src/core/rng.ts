/** Small seeded PRNG (mulberry32) so agents regenerate identically from a seed. */
export class Rng {
  private s: number;
  constructor(seed: number) {
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
