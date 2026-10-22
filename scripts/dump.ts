/**
 * dump=<file> for the headless scripts: the run's DayReports, the finance state and hashes of the
 * mode shares and observations, as JSON. Two runs (e.g. at a git tag and in the working tree)
 * can then be compared field by field (identity checks).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Game } from '../src/core/game';
import type { Engine } from '../src/sim/engine';
import type { DayReport, DayStories, StoryPick, TraceData } from '../src/sim/protocol';

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

/**
 * trace=1: Commuter stories in use, as in the browser: the commuter of the day on, a story picked
 * every 90 game minutes from 05:00 to 23:00 (in turn a random rider, someone at a station, and
 * yesterday's commuter of the day), and a snapshot (with its story) every 50 steps. Everything it
 * calls only reads the sim, so a run's dump= must not change. `report` prints what was traced.
 */
export function storyDriver(): { onStep: (e: Engine) => void; dayStories: (s: DayStories) => void; report: (engine: Engine, path?: string) => void } {
  const traces: TraceData[] = [];
  const days: DayStories[] = [];
  let steps = 0, salt = 0, lastPick = -Infinity, snaps = 0, misses = 0;
  const keep = (e: Engine) => {
    const d = e.stories?.copy();
    if (d) traces.push(d);
  };
  return {
    dayStories: (s) => days.push(s),
    onStep: (engine) => {
      if (++steps % 50 === 0 && engine.snapshot(0).story) snaps++;
      const t = engine.time, tod = t % 86400;
      if (t - lastPick < 5400 || tod < 5 * 3600 || tod > 23 * 3600) return;
      lastPick = t;
      keep(engine);
      salt++;
      let pick: StoryPick = { kind: 'random', salt };
      const st = engine.net?.stations ?? [];
      if (salt % 3 === 1 && st.length) pick = { kind: 'station', stations: [st[(salt * 7) % st.length].id], salt };
      if (salt % 3 === 2) {
        const who = days[days.length - 1]?.stories.find((x) => !x.who.event)?.who;
        if (who) pick = { kind: 'who', who };
      }
      if (!engine.storyPick(pick)) misses++;
    },
    report: (engine, path) => {
      keep(engine);
      const kinds: Record<string, number> = {};
      let events = 0;
      const ended: Record<string, number> = {};
      for (const tr of traces) {
        events += tr.events.length;
        for (const e of tr.events) kinds[e.k] = (kinds[e.k] ?? 0) + 1;
        ended[tr.ended ?? 'open'] = (ended[tr.ended ?? 'open'] ?? 0) + 1;
      }
      const cats: Record<string, number> = {};
      for (const d of days) for (const s of d.stories) cats[s.cat] = (cats[s.cat] ?? 0) + 1;
      console.log(`stories: ${traces.length} traces (${misses} picks found nobody), ${events} events ${JSON.stringify(kinds)} · ended ${JSON.stringify(ended)} · ${snaps} snapshots with a story · commuter of the day ${JSON.stringify(cats)} over ${days.length} days`);
      if (path) writeFileSync(path, JSON.stringify({ traces, days }));
    },
  };
}
