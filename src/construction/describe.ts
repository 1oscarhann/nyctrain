/** Human-readable descriptions of track for tooltips and panels. */
import { QUAD } from '../balance';
import { fmtDistance, fmtMoney, fmtSpeed } from '../core/units';
import type { Game } from '../core/game';
import { edgeReport, LEVEL_NAMES, quadCostFactor } from './validate';
import type { Network } from './network';
import { progress } from './blueprint';
import type { TrackEdge } from './types';

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function levelLabel(net: Game['network'], edgeId: number): string {
  const e = net.edges.get(edgeId)!;
  const la = net.nodes.get(e.a)!.level;
  const lb = net.nodes.get(e.b)!.level;
  return la === lb ? cap(LEVEL_NAMES[la]) : `Ramp: ${LEVEL_NAMES[la]} → ${LEVEL_NAMES[lb]}`;
}

/**
 * Which part of a four-track section an edge is (null for ordinary double track). With the
 * network, the express pair's factor is the one it is priced at (full price where no local pair
 * runs alongside).
 */
export function quadLabel(e: TrackEdge, net?: Network): string | null {
  if (!e.quad) return null;
  if (e.quad.role === 'local') return 'Local pair';
  const f = net ? quadCostFactor(net, e) : e.quad.role === 'express' ? QUAD.secondPairCostFactor : QUAD.linkCostFactor;
  const x = `×${Math.round(f * 100) / 100}`;
  if (e.quad.role === 'express') return f >= 1 ? 'Express pair · no local pair alongside, full price' : `Express pair · shared works ${x}`;
  return f >= 1 ? 'Turnout or crossover · full price' : `Turnout or crossover · ${x}`;
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
  const quad = quadLabel(e, net);
  if (quad) lines.splice(1, 0, `<div class="row"><span class="hw-muted">Four-track</span><span class="num">${quad}</span></div>`);
  if (r.waterLength > 0) lines.push(`<div class="row"><span class="hw-muted">Over water</span><span class="num">${fmtDistance(r.waterLength)}</span></div>`);
  if (r.densityMult > 1.05 && e.status === 'blueprint') lines.push(`<div class="row"><span class="hw-muted">Density premium</span><span class="num">×${r.densityMult.toFixed(1)}</span></div>`);
  lines.push(`<div>${status}</div>`);
  if (!r.ok && e.status === 'blueprint') lines.push(`<div class="reason hw-red">${r.errors[0]}</div>`);
  return lines.join('');
}
