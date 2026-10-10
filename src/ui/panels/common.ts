import { h, svgIcon } from '../dom';
import { ICONS } from '../icons';

export interface Panel {
  el: HTMLElement;
  /** Live refresh (called a few times a second while open). */
  update?(): void;
  /** Called after a day closes. */
  dayEnd?(): void;
  destroy?(): void;
}

export function shell(kicker: string, title: Node | string, onClose: () => void, lead?: Node | null): { el: HTMLElement; body: HTMLElement; titleEl: HTMLElement } {
  const titleEl = h('h2', null, title);
  const close = h('button', { class: 'hw-btn ghost small', title: 'Close', onclick: onClose }, svgIcon(ICONS.close));
  const body = h('div', { class: 'side-body' });
  const el = h(
    'div',
    { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
    h('div', { class: 'side-head' }, lead ?? null, h('div', { class: 'titles' }, h('div', { class: 'kicker' }, kicker), titleEl), close),
    body,
  );
  return { el, body, titleEl };
}

export function statCard(label: string, value: string, tone?: 'green' | 'amber' | 'red'): HTMLElement {
  return h('div', { class: 'stat-card' }, h('div', { class: 'label' }, label), h('div', { class: `value ${tone ? 'hw-' + tone : ''}` }, value));
}

export function kv(rows: [string, string | Node][]): HTMLElement {
  const el = h('div', { class: 'kv' });
  for (const [k, v] of rows) el.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  return el;
}

export function section(title: string): HTMLElement {
  return h('div', { class: 'section' }, title);
}

/** Horizontal stacked share bar with labelled legend (identity never colour-only). */
export function shareBar(parts: { label: string; value: number; color: string }[]): HTMLElement {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const bar = h('div', { style: 'display:flex;height:12px;border-radius:6px;overflow:hidden;gap:2px;margin:6px 0' });
  const legend = h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;font-size:12px' });
  for (const p of parts) {
    const f = p.value / total;
    if (f > 0.001) bar.append(h('div', { style: { width: `${f * 100}%`, background: p.color } }));
    legend.append(
      h('span', { style: 'display:inline-flex;align-items:center;gap:5px' }, h('span', { style: { width: '9px', height: '9px', borderRadius: '2px', background: p.color, display: 'inline-block' } }), `${p.label} `, h('b', { class: 'num' }, `${(f * 100).toFixed(1)}%`)),
    );
  }
  return h('div', null, bar, legend);
}

/** Muted grey, teal, orange — validated against the panel surface. */
export const SHARE_COLORS = { walk: '#8E99A5', drive: '#D8731C', transit: '#00A3B0' };
