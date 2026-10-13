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
