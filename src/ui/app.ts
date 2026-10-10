import { MapView } from '../map/mapView';
import { fetchWorld } from '../data/world';
import { Overlays, OVERLAY_LABELS, type OverlayMode } from '../map/overlays';
import { fmtDensity } from '../core/units';
import { h } from './dom';
import { rampCss } from '../map/colorRamp';

export async function bootstrap(root: HTMLElement): Promise<void> {
  const loading = h('div', { id: 'loading' }, 'Loading New York…');
  root.append(loading);
  const [view, world] = await Promise.all([MapView.create(document.getElementById('map')!), fetchWorld()]);
  loading.remove();
  const overlays = new Overlays(world.tracts, fmtDensity);
  view.addLayers('overlays', () => overlays.layers());
  const legend = h('div', { id: 'legend', class: 'hw-panel' });
  root.append(legend);
  const bar = h('div', { class: 'hw-panel', style: 'position:absolute;top:8px;left:8px;padding:6px;display:flex;gap:4px;z-index:20' });
  for (const m of ['none', 'residents', 'jobs'] as OverlayMode[]) {
    bar.append(h('button', { class: 'hw-btn small', id: 'ov-' + m, onclick: () => { overlays.setMode(m); view.invalidate(); renderLegend(); } }, OVERLAY_LABELS[m]));
  }
  bar.append(h('button', { class: 'hw-btn small', id: 'view3d', onclick: () => view.toggleView3D() }, '3D (V)'));
  root.append(bar);
  function renderLegend() {
    const l = overlays.legend();
    legend.className = 'hw-panel' + (l ? ' open' : '');
    legend.replaceChildren();
    if (l) legend.append(h('div', null, l.title), h('div', { class: 'bar', style: { background: rampCss(l.ramp) } }), h('div', { class: 'ends' }, h('span', null, l.lo), h('span', null, l.hi)));
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'v' || e.key === 'V') view.toggleView3D(); });
  (window as unknown as Record<string, unknown>).hw = { view, overlays, world };
}
