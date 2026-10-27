/**
 * A line opened during the day carries riders that day: commuters who haven't set off yet switch
 * to it (at the odds they'd have had if it had been there at 3 am), instead of waiting for tomorrow.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyCity } from '../src/cities';
import { compileNetwork } from '../src/routes/compile';
import { loadLandFromDisk, loadWorldFromDisk } from '../scripts/nodeData';
import { createHeadlessGame, drawLine, makeRoute, startEngine, stationNear, stepUntil } from '../src/sim/headless';
import type { DayReport } from '../src/sim/protocol';

afterAll(() => applyCity('nyc'));
type LL = [number, number];
const L = (lat: number, lon: number): LL => [lon, lat];

function run(openRoute: boolean) {
  applyCity('london');
  const game = createHeadlessGame(loadWorldFromDisk(), loadLandFromDisk(), { sandbox: true });
  drawLine(game, [L(51.4927, -0.224), L(51.515, -0.142), L(51.524, -0.07), L(51.5416, -0.0034)], 'deep');
  const pts = [L(51.4927, -0.224), L(51.502, -0.19), L(51.51, -0.165), L(51.515, -0.142), L(51.518, -0.112), L(51.522, -0.085), L(51.524, -0.07), L(51.53, -0.045), L(51.5416, -0.0034)];
  const stops = pts.map((p, i) => stationNear(game, p, `P${i}`, 8));
  expect(game.build(true).ok).toBe(true);
  const reports: DayReport[] = [];
  const engine = startEngine(game, { agentScale: 20, reports });
  // The day is planned with no route; at 06:00 the route opens.
  const day0 = Math.floor(game.time / 86400) * 86400;
  stepUntil(engine, day0 + 6 * 3600);
  if (openRoute) {
    makeRoute(game, 'East–West', 'EW', '#DC241F', stops, 8, { am: 3, pm: 3, midday: 6, evening: 8, night: 0 });
    engine.setNetwork(compileNetwork(game).net);
  }
  stepUntil(engine, day0 + 86400 + 60);
  return reports[0];
}

describe('a line opened during the day', () => {
  it('carries riders the same day', () => {
    const r = run(true);
    if (process.env.PRINT) console.log('SAMEDAY', r.riders, r.transitShare);
    expect(r.riders).toBeGreaterThan(5000);
    expect(r.transitShare).toBeGreaterThan(0);
    const none = run(false);
    expect(none.riders).toBe(0);
  }, 180_000);
});
