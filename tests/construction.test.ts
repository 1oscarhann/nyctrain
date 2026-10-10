import { describe, expect, it } from 'vitest';
import { computeFillet, curveSpeed, filletPoint, radiusForTangent } from '../src/construction/geometry';
import { Network } from '../src/construction/network';
import { edgeReport, stationReport, type Terrain } from '../src/construction/validate';
import { TRACK } from '../src/balance';
import { setUnits } from '../src/core/units';

setUnits('metric');

/** Land everywhere except a 500 m wide river at 1000 ≤ x ≤ 1500. Uniform density. */
const river: Terrain = {
  isWater: (x) => x >= 1000 && x <= 1500,
  density: () => 10000,
};
const dry: Terrain = { isWater: () => false, density: () => 0 };

describe('arc fillets', () => {
  it('produces tangent points at r·tan(θ/2) and an arc of the right radius', () => {
    // 90° left turn at the origin.
    const f = computeFillet(-1000, 0, 0, 0, 0, 1000, 200)!;
    expect(f).not.toBeNull();
    expect(f.theta).toBeCloseTo(Math.PI / 2, 6);
    expect(f.sign).toBe(1);
    expect(f.t).toBeCloseTo(200, 6);
    expect(f.t1x).toBeCloseTo(-200, 6);
    expect(f.t1y).toBeCloseTo(0, 6);
    expect(f.t2x).toBeCloseTo(0, 6);
    expect(f.t2y).toBeCloseTo(200, 6);
    // Every arc point is r from the centre.
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const [x, y] = filletPoint(f, frac);
      expect(Math.hypot(x - f.cx, y - f.cy)).toBeCloseTo(200, 6);
    }
    expect(filletPoint(f, 1)[0]).toBeCloseTo(0, 6);
  });

  it('handles right turns and straight lines', () => {
    const f = computeFillet(0, 0, 1000, 0, 2000, -500, 300)!;
    expect(f.sign).toBe(-1);
    expect(computeFillet(0, 0, 1000, 0, 2000, 0, 300)).toBeNull();
  });

  it('radiusForTangent inverts t = r·tan(θ/2)', () => {
    expect(radiusForTangent(200, Math.PI / 2)).toBeCloseTo(200, 6);
    expect(radiusForTangent(250, Math.PI / 3)).toBeCloseTo(250 / Math.tan(Math.PI / 6), 6);
  });

  it('curve speed is √(a·r)', () => {
    expect(curveSpeed(400)).toBeCloseTo(20, 6);
    expect(curveSpeed(Infinity)).toBe(Infinity);
  });
});

describe('track network geometry', () => {
  it('builds a smoothed path whose length matches straights + arcs', () => {
    const net = new Network();
    const ids = net.addStroke(
      [
        { x: 0, y: 0, level: 'deep' },
        { x: 1000, y: 0, level: 'deep' },
        { x: 1000, y: 1000, level: 'deep' },
      ],
      'heavy',
      { kind: 'none' },
      { kind: 'none' },
    );
    expect(ids.length).toBe(2);
    const mid = [...net.nodes.values()].find((n) => n.x === 1000 && n.y === 0)!;
    // Tangent is capped, so r = cap / tan(45°).
    expect(mid.r).toBeCloseTo(TRACK.filletMaxTangent, 3);
    const total = ids.reduce((s, id) => s + net.geom(id).length, 0);
    const t = TRACK.filletMaxTangent;
    const expected = 2 * (1000 - t) + (Math.PI / 2) * mid.r;
    expect(Math.abs(total - expected)).toBeLessThan(1.0);
    // Edges meet with matching headings (smooth).
    const g1 = net.geom(ids[0]);
    const g2 = net.geom(ids[1]);
    const n1 = g1.xs.length;
    expect(g1.xs[n1 - 1]).toBeCloseTo(g2.xs[0], 6);
    expect(g1.ys[n1 - 1]).toBeCloseTo(g2.ys[0], 6);
  });

  it('flags curves tighter than the minimum radius', () => {
    const net = new Network();
    // Sharp 150° turn with short legs → tiny radius.
    const ids = net.addStroke(
      [
        { x: 0, y: 0, level: 'deep' },
        { x: 120, y: 0, level: 'deep' },
        { x: 20, y: 60, level: 'deep' },
      ],
      'heavy',
      { kind: 'none' },
      { kind: 'none' },
    );
    const rep = edgeReport(net, ids[0], dry);
    expect(rep.ok).toBe(false);
    expect(rep.errors.join(' ')).toMatch(/Curve too tight/);
  });

  it('branches off a straight section with a junction that leaves tangentially', () => {
    const net = new Network();
    const [main] = net.addStroke(
      [
        { x: 0, y: 0, level: 'at-grade' },
        { x: 3000, y: 0, level: 'at-grade' },
      ],
      'heavy',
      { kind: 'none' },
      { kind: 'none' },
    );
    const check = net.canSplitAt(main, 1000, 'heavy');
    expect(check.ok).toBe(true);
    const branch = net.addStroke(
      [
        { x: 1000, y: 0, level: 'at-grade' },
        { x: 2000, y: 800, level: 'at-grade' },
      ],
      'heavy',
      { kind: 'edge', edge: main, u: 1000 },
      { kind: 'none' },
    );
    expect(branch.length).toBe(2); // junction → lead → end
    const J = [...net.nodes.values()].find((n) => n.anchor && net.degree(n.id) === 3)!;
    expect(J).toBeTruthy();
    // Branch leaves straight along the main line heading.
    const [hx, hy] = net.departHeading(branch[0], J.id);
    expect(Math.abs(hx * J.hx + hy * J.hy)).toBeGreaterThan(0.999);
    for (const id of branch) expect(edgeReport(net, id, dry).errors).toEqual([]);
    // Original main line geometry is unchanged in total.
    const mainLen = [...net.edges.values()].filter((e) => !branch.includes(e.id)).reduce((s, e) => s + net.geom(e.id).length, 0);
    expect(mainLen).toBeCloseTo(3000, 3);
  });
});

describe('ramps and grades', () => {
  it('requires height change ÷ max grade of ramp', () => {
    const net = new Network();
    // elevated (+8) to deep (−25) = 33 m; heavy 4% → 825 m. Give it 413 m.
    const ids = net.addStroke(
      [
        { x: 0, y: 0, level: 'elevated' },
        { x: 413, y: 0, level: 'deep' },
      ],
      'heavy',
      { kind: 'none' },
      { kind: 'none' },
    );
    const rep = edgeReport(net, ids[0], dry);
    expect(rep.ok).toBe(false);
    expect(rep.errors[0]).toBe('Needs 412 m more ramp to go from elevated to deep tunnel');
  });

  it('accepts a long enough ramp, and light metro allows 6%', () => {
    const heavy = new Network();
    const h = heavy.addStroke(
      [
        { x: 0, y: 0, level: 'at-grade' },
        { x: 830, y: 0, level: 'deep' },
      ],
      'heavy',
      { kind: 'none' },
      { kind: 'none' },
    );
    expect(edgeReport(heavy, h[0], dry).ok).toBe(true);
    const light = new Network();
    const l = light.addStroke(
      [
        { x: 0, y: 0, level: 'at-grade' },
        { x: 420, y: 0, level: 'deep' },
      ],
      'light',
      { kind: 'none' },
      { kind: 'none' },
    );
    expect(edgeReport(light, l[0], dry).ok).toBe(true);
  });
});

describe('water crossings', () => {
  const cross = (level: 'elevated' | 'at-grade' | 'cut-and-cover' | 'deep') => {
    const net = new Network();
    const ids = net.addStroke(
      [
        { x: 0, y: 0, level },
        { x: 2500, y: 0, level },
      ],
      'heavy',
      { kind: 'none' },
      { kind: 'none' },
    );
    return edgeReport(net, ids[0], river);
  };

  it('allows bridges and deep tunnels', () => {
    expect(cross('elevated').ok).toBe(true);
    expect(cross('deep').ok).toBe(true);
  });

  it('rejects at-grade and cut-and-cover over water', () => {
    const a = cross('at-grade');
    expect(a.ok).toBe(false);
    expect(a.errors[0]).toMatch(/At-grade track can't cross water/);
    expect(cross('cut-and-cover').ok).toBe(false);
  });

  it('measures the water length', () => {
    expect(cross('deep').waterLength).toBeGreaterThan(480);
    expect(cross('deep').waterLength).toBeLessThan(520);
  });
});

describe('cost calculator', () => {
  const line = (level: 'elevated' | 'at-grade' | 'cut-and-cover' | 'deep', cls: 'heavy' | 'light', terrain: Terrain) => {
    const net = new Network();
    const ids = net.addStroke(
      [
        { x: 0, y: 2000, level },
        { x: 1000, y: 2000, level },
      ],
      cls,
      { kind: 'none' },
      { kind: 'none' },
    );
    return edgeReport(net, ids[0], terrain);
  };

  it('uses the per-km base costs on empty land', () => {
    expect(line('at-grade', 'heavy', dry).cost).toBeCloseTo(40e6, -3);
    expect(line('elevated', 'heavy', dry).cost).toBeCloseTo(90e6, -3);
    expect(line('cut-and-cover', 'heavy', dry).cost).toBeCloseTo(160e6, -3);
    expect(line('deep', 'heavy', dry).cost).toBeCloseTo(280e6, -3);
  });

  it('applies the density multiplier to surface levels only', () => {
    const dense: Terrain = { isWater: () => false, density: () => 50000 };
    const m = 1 + TRACK.densityK * 50000;
    expect(line('at-grade', 'heavy', dense).cost).toBeCloseTo(40e6 * m, -3);
    expect(line('deep', 'heavy', dense).cost).toBeCloseTo(280e6, -3);
  });

  it('charges bridges ×3 and underwater tunnels ×1.5', () => {
    const wet: Terrain = { isWater: () => true, density: () => 0 };
    expect(line('elevated', 'heavy', wet).cost).toBeCloseTo(270e6, -3);
    expect(line('deep', 'heavy', wet).cost).toBeCloseTo(420e6, -3);
  });

  it('makes light metro 30% cheaper', () => {
    expect(line('deep', 'light', dry).cost).toBeCloseTo(196e6, -3);
  });

  it('prices stations by level plus platform length', () => {
    const net = new Network();
    const ids = net.addStroke(
      [
        { x: 0, y: 0, level: 'deep' },
        { x: 2000, y: 0, level: 'deep' },
      ],
      'heavy',
      { kind: 'none' },
      { kind: 'none' },
    );
    const r = stationReport(net, ids[0], 1000, 8, dry);
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(200e6 + 8e6);
    net.addStation(ids[0], 1000, 8, 'A');
    const tooClose = stationReport(net, ids[0], 1300, 8, dry);
    expect(tooClose.ok).toBe(false);
    expect(tooClose.errors.join(' ')).toMatch(/Too close to A/);
  });
});
