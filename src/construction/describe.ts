/** Human-readable descriptions of track for tooltips and panels. */
import { fmtDistance, fmtMoney, fmtSpeed } from '../core/units';
import type { Game } from '../core/game';
import { edgeReport, LEVEL_NAMES } from './validate';
import { progress } from './blueprint';

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function levelLabel(net: Game['network'], edgeId: number): string {
  const e = net.edges.get(edgeId)!;
  const la = net.nodes.get(e.a)!.level;
  const lb = net.nodes.get(e.b)!.level;
  return la === lb ? cap(LEVEL_NAMES[la]) : `Ramp: ${LEVEL_NAMES[la]} → ${LEVEL_NAMES[lb]}`;
}

export function edgeTooltip(game: Game, edgeId: number): string {
  const net = game.network;
  const e = net.edges.get(edgeId);
  if (!e) return '';
  const r = edgeReport(net, edgeId, game.terrain);
  const status =
    e.status === 'blueprint'
      ? '<span class="hw-muted">Blueprint</span>'
      : e.status === 'construction'
        ? `<span class="hw-amber">Under construction · ${Math.floor(progress(e, game.time) * 100)}%</span>`
        : '<span class="hw-green">Built</span>';
  const cost = e.status === 'blueprint' ? r.cost : e.cost;
  const curve = isFinite(r.minRadius) ? `${fmtDistance(r.minRadius, true)} radius` : 'Straight';
  const lines = [
    `<div class="title">${levelLabel(net, edgeId)} · ${cap(e.cls)} metro</div>`,
    `<div class="row"><span class="hw-muted">Length</span><span class="num">${fmtDistance(r.length)}</span></div>`,
    `<div class="row"><span class="hw-muted">Curve</span><span class="num">${curve} · ${fmtSpeed(r.speedLimit)} max</span></div>`,
    `<div class="row"><span class="hw-muted">${e.status === 'blueprint' ? 'Cost' : 'Built for'}</span><span class="num">${fmtMoney(cost)}</span></div>`,
  ];
  if (r.waterLength > 0) lines.push(`<div class="row"><span class="hw-muted">Over water</span><span class="num">${fmtDistance(r.waterLength)}</span></div>`);
  if (r.densityMult > 1.05 && e.status === 'blueprint') lines.push(`<div class="row"><span class="hw-muted">Density premium</span><span class="num">×${r.densityMult.toFixed(1)}</span></div>`);
  lines.push(`<div>${status}</div>`);
  if (!r.ok && e.status === 'blueprint') lines.push(`<div class="reason hw-red">${r.errors[0]}</div>`);
  return lines.join('');
}
