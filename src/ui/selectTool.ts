/**
 * Default tool: click a station, train, track or tract to inspect it; hover for quick info.
 */
import { TRACK } from '../balance';
import { pickEdge } from '../construction/pick';
import { edgeTooltip } from '../construction/describe';
import { fmtCount } from '../core/units';
import type { App } from './app';
import type { Pointer, Tool } from './toolTypes';

export class SelectTool implements Tool {
  readonly id = 'select' as const;
  readonly xray = false;

  constructor(private app: App) {}

  move(p: Pointer): void {
    const app = this.app;
    const train = app.view.pick(p.px, ['trains']);
    if (train !== null) {
      const t = app.trains.data.find((d) => d.id === train);
      if (t) {
        const r = app.compiledRoute(t.train.route);
        app.tip(r ? `<div class="title">${r.bullet} ${r.name}</div><div class="hw-muted">${fmtCount(t.train.load * app.agentScale)} on board · click for details</div>` : null, p.px);
        return;
      }
    }
    const sid = app.stations.pick(p.x, p.y, app.tol(10));
    if (sid !== null) {
      const s = app.game.network.stations.get(sid)!;
      const b = app.report?.stationBoardings[sid];
      app.tip(`<div class="title">${s.name}</div><div class="hw-muted">${b !== undefined ? `${fmtCount(b)} boardings yesterday · ` : ''}click for details</div>`, p.px);
      return;
    }
    const hit = pickEdge(app.game.network, p.x, p.y, app.tol(TRACK.snapPx * 0.7));
    if (hit) {
      app.tip(edgeTooltip(app.game, hit.edge), p.px);
      return;
    }
    app.tip(null);
  }

  click(p: Pointer): void {
    const app = this.app;
    const train = app.view.pick(p.px, ['trains']);
    if (train !== null) return app.game.select({ kind: 'train', id: train });
    const sid = app.stations.pick(p.x, p.y, app.tol(10));
    if (sid !== null) return app.game.select({ kind: 'station', id: sid });
    const hit = pickEdge(app.game.network, p.x, p.y, app.tol(TRACK.snapPx * 0.7));
    if (hit) return app.game.select({ kind: 'edge', id: hit.edge });
    const tract = app.tractIndex.nearest(p.x, p.y);
    if (tract && Math.hypot(tract.x - p.x, tract.y - p.y) < Math.max(400, tract.radius * 1.3) && !app.terrain.isWater(p.x, p.y)) {
      return app.game.select({ kind: 'tract', index: tract.index });
    }
    app.game.select(null);
  }

  leave(): void {
    this.app.tip(null);
  }
}
