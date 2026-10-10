/**
 * uPlot charts for the panels. Dark surface, recessive axes and grid, thin marks, hover readout
 * through uPlot's live legend. Series colours validated against the panel surface (#161B21):
 * teal #00A3B0 and orange #D8731C pass lightness, chroma, CVD and contrast checks.
 */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export const CHART_TEAL = '#00A3B0';
export const CHART_ORANGE = '#D8731C';
const AXIS = '#8E99A5';
const GRID = 'rgba(231,235,239,0.07)';
const FONT = '11px Overpass, sans-serif';

function axis(extra: Partial<uPlot.Axis> = {}): uPlot.Axis {
  return { stroke: AXIS, font: FONT, grid: { stroke: GRID, width: 1 }, ticks: { show: false }, size: 34, gap: 4, ...extra };
}

const bars = uPlot.paths.bars!({ size: [0.72, 24], radius: 0.25 });

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

/** Single-series bars (e.g. boardings by hour). The panel heading names the series. */
export function barChart(el: HTMLElement, xs: number[], ys: number[], color: string, xLabel: (x: number) => string, name: string, width = 330, height = 150): uPlot {
  const u = new uPlot(
    {
      width,
      height,
      padding: [8, 6, 0, 0],
      legend: { show: true, live: true },
      cursor: { points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: (_u, a, b) => [a - 0.6, b + 0.6] }, y: { range: (_u, _a, b) => [0, Math.max(1, b) * 1.1] } },
      axes: [axis({ values: (_u, vals) => vals.map((v) => (Number.isInteger(v) ? xLabel(v) : '')), size: 26 }), axis({ values: (_u, vals) => vals.map(compact), size: 38 })],
      series: [{ label: 'Hour', value: (_u, v) => (v == null ? '—' : xLabel(v)) }, { label: name, stroke: color, fill: color, width: 0, paths: bars, points: { show: false }, value: (_u, v) => (v == null ? '—' : Math.round(v).toLocaleString()) }],
    },
    [xs, ys],
    el,
  );
  return u;
}

/** Load (bars, route colour) against offered capacity (dashed step line) per segment. */
export function loadChart(el: HTMLElement, load: number[], capacity: number[], color: string, segLabel: (i: number) => string, width = 330, height = 150): uPlot {
  const xs = load.map((_, i) => i);
  return new uPlot(
    {
      width,
      height,
      padding: [8, 6, 0, 0],
      legend: { show: true, live: true },
      cursor: { points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: (_u, a, b) => [a - 0.6, b + 0.6] }, y: { range: (_u, _a, b) => [0, Math.max(1, b) * 1.12] } },
      axes: [axis({ values: (_u, vals) => vals.map((v) => (Number.isInteger(v) ? String(v + 1) : '')), size: 22 }), axis({ values: (_u, vals) => vals.map(compact), size: 38 })],
      series: [
        { label: 'Segment', value: (_u, v) => (v == null ? '—' : segLabel(v)) },
        { label: 'Riders/h', stroke: color, fill: color, width: 0, paths: bars, points: { show: false }, value: (_u, v) => (v == null ? '—' : Math.round(v).toLocaleString()) },
        { label: 'Capacity/h', stroke: '#C9D1D9', width: 1.5, dash: [4, 3], paths: uPlot.paths.stepped!({ align: 1 }), points: { show: false }, value: (_u, v) => (v == null ? '—' : Math.round(v).toLocaleString()) },
      ],
    },
    [xs, load, capacity],
    el,
  );
}

/** Monthly revenue vs operating costs (two lines, legend + hover readout). */
export function financeChart(el: HTMLElement, labels: string[], revenue: number[], costs: number[], width = 330, height = 170): uPlot {
  const xs = labels.map((_, i) => i);
  const fmt = (v: number | null) => (v == null ? '—' : '$' + compact(v));
  return new uPlot(
    {
      width,
      height,
      padding: [10, 8, 0, 0],
      legend: { show: true, live: true },
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: (_u, a, b) => [a - 0.3, b + 0.3] }, y: { range: (_u, _a, b) => [0, Math.max(1, b) * 1.12] } },
      axes: [axis({ values: (_u, vals) => vals.map((v) => (Number.isInteger(v) && labels[v] ? labels[v].slice(0, 3) : '')), size: 22 }), axis({ values: (_u, vals) => vals.map((v) => '$' + compact(v)), size: 46 })],
      series: [
        { label: 'Month', value: (_u, v) => (v == null ? '—' : labels[v] ?? '') },
        { label: 'Revenue', stroke: CHART_TEAL, width: 2, points: { show: labels.length < 3, size: 8, fill: CHART_TEAL }, value: (_u, v) => fmt(v) },
        { label: 'Operating costs', stroke: CHART_ORANGE, width: 2, points: { show: labels.length < 3, size: 8, fill: CHART_ORANGE }, value: (_u, v) => fmt(v) },
      ],
    },
    [xs, revenue, costs],
    el,
  );
}
