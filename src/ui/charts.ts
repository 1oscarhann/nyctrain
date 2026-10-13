/**
 * uPlot charts for the panels. Dark surface, recessive axes and grid, thin marks, hover readout
 * through uPlot's live legend. Series colours validated against the panel surface (#161B21):
 * teal #00A3B0 and orange #D8731C pass lightness, chroma, CVD and contrast checks.
 */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { currency } from '../core/units';

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
  const n = xs.length;
  // Label every segment when few, else about six.
  const step = Math.max(1, Math.ceil(n / 6));
  const xSplits = xs.filter((i) => i % step === 0);
  return new uPlot(
    {
      width,
      height,
      padding: [8, 6, 0, 0],
      legend: { show: true, live: true },
      cursor: { points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: () => [-0.6, n - 1 + 0.6] }, y: { range: (_u, _a, b) => [0, Math.max(1, b) * 1.12] } },
      axes: [axis({ splits: () => xSplits, values: (_u, vals) => vals.map((v) => String(v + 1)), size: 22 }), axis({ values: (_u, vals) => vals.map(compact), size: 38 })],
      series: [
        { label: 'Segment', value: (_u, v) => (v == null ? '—' : segLabel(v)) },
        { label: 'Riders/h', stroke: color, fill: color, width: 0, paths: bars, points: { show: false }, value: (_u, v) => (v == null ? '—' : Math.round(v).toLocaleString()) },
        // A stepped line needs two points; one or two segments get a capacity tick per bar instead.
        n > 2
          ? { label: 'Capacity/h', stroke: '#C9D1D9', width: 1.5, dash: [4, 3], paths: uPlot.paths.stepped!({ align: 1 }), points: { show: false }, value: (_u, v) => (v == null ? '—' : Math.round(v).toLocaleString()) }
          : { label: 'Capacity/h', stroke: '#C9D1D9', width: 0, paths: () => null, points: { show: true, size: 9, width: 2, fill: '#C9D1D9', stroke: '#C9D1D9' }, value: (_u, v) => (v == null ? '—' : Math.round(v).toLocaleString()) },
      ],
    },
    [xs, load, capacity],
    el,
  );
}

/** Monthly revenue vs operating costs (two lines, legend + hover readout). */
export function financeChart(el: HTMLElement, labels: string[], revenue: number[], costs: number[], width = 330, height = 170): uPlot {
  const xs = labels.map((_, i) => i);
  const fmt = (v: number | null) => (v == null ? '—' : currency() + compact(v));
  return new uPlot(
    {
      width,
      height,
      padding: [10, 8, 0, 0],
      legend: { show: true, live: true },
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: () => [-0.3, xs.length - 1 + 0.3] }, y: { range: (_u, _a, b) => [0, Math.max(1, b) * 1.12] } },
      axes: [axis({ splits: () => xs.filter((i) => i % Math.max(1, Math.ceil(xs.length / 8)) === 0), values: (_u, vals) => vals.map((v) => labels[v]?.slice(0, 3) ?? ''), size: 22 }), axis({ values: (_u, vals) => vals.map((v) => currency() + compact(v)), size: 46 })],
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

const GUIDE = '#C9D1D9';

/**
 * Bond market history (§2.4 Borrowing): the market's base rate (teal), the authority's new-bond
 * rate (orange) and the average coupon of its debt (grey dashed), in percent, one point a month.
 */
export function rateChart(el: HTMLElement, labels: string[], base: number[], yours: number[], avgCost: (number | null)[], width = 330, height = 160): uPlot {
  const xs = labels.map((_, i) => i);
  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
  const all = [...base, ...yours, ...avgCost.filter((v): v is number => v != null && v > 0)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const few = labels.length < 3;
  return new uPlot(
    {
      width,
      height,
      padding: [10, 8, 0, 0],
      legend: { show: true, live: true },
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: () => [-0.3, Math.max(1, xs.length - 1) + 0.3] }, y: { range: () => [Math.max(0, Math.floor((lo - 0.0025) * 200) / 200), Math.ceil((hi + 0.0025) * 200) / 200] } },
      axes: [
        axis({ splits: () => xs.filter((i) => i % Math.max(1, Math.ceil(xs.length / 6)) === 0), values: (_u, vals) => vals.map((v) => labels[v]?.slice(0, 3) ?? ''), size: 22 }),
        axis({ values: (_u, vals) => vals.map((v) => `${(v * 100).toFixed(1)}%`), size: 42 }),
      ],
      series: [
        { label: 'Month', value: (_u, v) => (v == null ? '—' : labels[v] ?? '') },
        { label: 'Market', stroke: CHART_TEAL, width: 2, points: { show: few, size: 7, fill: CHART_TEAL }, value: (_u, v) => pct(v) },
        { label: 'Your new bonds', stroke: CHART_ORANGE, width: 2, points: { show: few, size: 7, fill: CHART_ORANGE }, value: (_u, v) => pct(v) },
        { label: 'Avg cost of debt', stroke: GUIDE, width: 1.5, dash: [4, 3], points: { show: few, size: 6, fill: GUIDE }, value: (_u, v) => pct(v) },
      ],
    },
    [xs, base, yours, avgCost],
    el,
  );
}

/**
 * Headway spread along the line (§2.2): headway CV per stop for both directions, in direction-0
 * stop order so they share the x axis, with a dashed guide at the "even" grade. −1 means no data.
 */
export function regularityChart(el: HTMLElement, stopLabels: string[], cv0: number[], cv1: number[], names: [string, string], guide: number, width = 330, height = 150): uPlot {
  const xs = stopLabels.map((_, i) => i);
  const n = xs.length;
  const clean = (a: number[]) => a.map((v) => (v >= 0 ? v : null));
  const y0 = clean(cv0);
  const y1 = clean(cv1);
  const max = Math.max(0, ...y0.map((v) => v ?? 0), ...y1.map((v) => v ?? 0));
  const step = Math.max(1, Math.ceil(n / 7));
  const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));
  return new uPlot(
    {
      width,
      height,
      padding: [10, 8, 0, 0],
      legend: { show: true, live: true },
      cursor: { points: { size: 7 }, drag: { x: false, y: false } },
      scales: { x: { time: false, range: () => [-0.4, Math.max(1, n - 1) + 0.4] }, y: { range: () => [0, Math.max(1, max * 1.1)] } },
      axes: [axis({ splits: () => xs.filter((i) => i % step === 0), values: (_u, vals) => vals.map((v) => String(v + 1)), size: 22 }), axis({ values: (_u, vals) => vals.map((v) => v.toFixed(1)), size: 32 })],
      series: [
        { label: 'Stop', value: (_u, v) => (v == null ? '—' : `${v + 1} · ${stopLabels[v] ?? ''}`) },
        { label: names[0], stroke: CHART_TEAL, width: 2, spanGaps: true, points: { show: n < 4, size: 6, fill: CHART_TEAL }, value: (_u, v) => fmt(v) },
        { label: names[1], stroke: CHART_ORANGE, width: 2, spanGaps: true, points: { show: n < 4, size: 6, fill: CHART_ORANGE }, value: (_u, v) => fmt(v) },
        { label: 'Even', stroke: GUIDE, width: 1, dash: [4, 3], points: { show: false }, value: () => `< ${guide.toFixed(2)}` },
      ],
    },
    [xs, y0, y1, xs.map(() => guide)],
    el,
  );
}
