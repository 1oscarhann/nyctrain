/**
 * Default tool: click a station, train, track or tract to inspect it; hover for quick info.
 * City chaos markers (incidents, event venues) are picked first and open Service alerts.
 */
import { TRACK } from '../balance';
import { pickEdge } from '../construction/pick';
import { edgeTooltip } from '../construction/describe';
import { fmtCount } from '../core/units';
import { tractGrowthSince } from '../map/growthMath';
import type { App } from './app';
import { capFirst, growthHoverText } from './livingCity';
import type { Pointer, Tool } from './toolTypes';
import { schoolTip } from '../map/schoolLayers';

export class SelectTool implements Tool {
  readonly id = 'select' as const;
  readonly xray = false;

  constructor(private app: App) {}

  move(p: Pointer): void {
    const app = this.app;
    const chaos = app.chaosTip(p.px);
    if (chaos) {
      app.tip(chaos, p.px);
      return;
    }
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
      // A cross-platform station (v2) is one: both platforms' boardings.
      const q = s.pair !== undefined ? app.game.network.stations.get(s.pair) : undefined;
      const bs = [sid, ...(q ? [q.id] : [])].map((x) => app.report?.stationBoardings[x]).filter((v): v is number => v !== undefined);
      const b = bs.length ? bs.reduce((x, y) => x + y, 0) : undefined;
      app.tip(`<div class="title">${s.name}${q ? ' <span class="hw-muted">· cross-platform</span>' : ''}</div><div class="hw-muted">${b !== undefined ? `${fmtCount(b)} boardings yesterday · ` : ''}click for details</div>`, p.px);
      return;
    }
    const hit = pickEdge(app.game.network, p.x, p.y, app.tol(TRACK.snapPx * 0.7));
    if (hit) {
      app.tip(edgeTooltip(app.game, hit.edge), p.px);
      return;
    }
    // City growth overlay: the neighbourhood under the pointer and its growth since the start.
    const gv = app.overlays.mode === 'growth' ? app.overlays.growth : null;
    if (gv) {
      const tract = this.tractAt(p.x, p.y);
      if (tract) {
        const name = capFirst(app.tractName(tract.index)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
        app.tip(`<div class="title">${name}</div><div class="hw-muted">${growthHoverText(tractGrowthSince(tract, gv))}</div>`, p.px);
        return;
      }
    }
    // Schools layer: the school under the pointer.
    const school = app.schools.pick(p.x, p.y, app.tol(8));
    if (school) {
      app.tip(schoolTip(school), p.px);
      return;
    }
    app.tip(null);
  }

  /** The tract under a point (the same test as a click), on land. */
  private tractAt(x: number, y: number) {
    const app = this.app;
    const tract = app.tractIndex.nearest(x, y);
    return tract && Math.hypot(tract.x - x, tract.y - y) < Math.max(400, tract.radius * 1.3) && !app.terrain.isWater(x, y) ? tract : null;
  }

  click(p: Pointer): void {
    const app = this.app;
    // City chaos markers first: an incident, then a venue opens Service alerts focused on it.
    const incident = app.view.pick(p.px, ['chaos-incidents']);
    if (incident !== null) return app.game.select({ kind: 'alerts', focus: incident });
    const venue = app.view.pick(p.px, ['chaos-venues']);
    if (venue !== null) return app.game.select({ kind: 'alerts', event: venue });
    const train = app.view.pick(p.px, ['trains']);
    if (train !== null) return app.game.select({ kind: 'train', id: train });
    const sid = app.stations.pick(p.x, p.y, app.tol(10));
    if (sid !== null) return app.game.select({ kind: 'station', id: sid });
    const hit = pickEdge(app.game.network, p.x, p.y, app.tol(TRACK.snapPx * 0.7));
    if (hit) return app.game.select({ kind: 'edge', id: hit.edge });
    const tract = this.tractAt(p.x, p.y);
    if (tract) return app.game.select({ kind: 'tract', index: tract.index });
    app.game.select(null);
  }

  leave(): void {
    this.app.tip(null);
  }
}
