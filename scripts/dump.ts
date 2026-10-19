/**
 * dump=<file> for the headless scripts: the run's DayReports, the finance state and hashes of the
 * mode shares and observations, as JSON. Two runs (e.g. at a git tag and in the working tree)
 * can then be compared field by field (identity checks).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Game } from '../src/core/game';
import type { Engine } from '../src/sim/engine';
import type { DayReport } from '../src/sim/protocol';

const sha = (a: Float32Array) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

export function dumpRun(path: string, reports: DayReport[], game: Game, engine: Engine): void {
  const c = engine.commuters;
  writeFileSync(
    path,
    JSON.stringify({
      reports,
      finance: game.finance.toData(),
      modes: c ? { shares: sha(c.shares), obsTime: sha(c.obsTime), obsCrowd: sha(c.obsCrowd) } : null,
    }),
  );
  console.log(`dumped ${reports.length} days to ${path}`);
}

/** timelapse=1: what the recorded Cinematic timelapse holds (and its save encoding, to `path`). */
export function timelapseRun(game: Game, path?: string): void {
  const tl = game.timelapse;
  const d = game.timelapseData();
  const last = tl.frames[tl.frames.length - 1];
  console.log(`timelapse: ${tl.frames.length} frames (days ${tl.frames[0]?.day ?? '—'}–${last?.day ?? '—'}) · ${tl.edges.size} edges, ${tl.stations.size} stations, ${tl.shapes.length} route shapes · last frame ${last?.edges.length ?? 0} edges, ${last?.routes.length ?? 0} routes · encoded ${(d.data.length + JSON.stringify(d.shapes).length).toLocaleString()} chars`);
  if (path) writeFileSync(path, JSON.stringify(d));
}
