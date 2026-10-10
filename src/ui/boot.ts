/**
 * Startup: load the data, show the title screen (over a slowly turning 3D skyline), start games.
 */
import { MAP } from '../balance';
import { toLonLat } from '../core/geo';
import { fmtDate } from '../core/calendar';
import { fmtCount, fmtMoney, setUnits } from '../core/units';
import { fetchLand, fetchWorld, type LandCollection, type World } from '../data/world';
import { MapView } from '../map/mapView';
import type { SaveFile } from '../save/format';
import { importFile, listSlots, readSlot, SLOTS } from '../save/store';
import { App } from './app';
import { h, svgIcon } from './dom';
import { ICONS } from './icons';
import { loadSettings, storeSettings } from './settings';
import { modal } from './widgets';
import { COMMUTERS } from '../balance';

let world: World;
let land: LandCollection;
let current: App | null = null;

export async function bootstrap(root: HTMLElement): Promise<void> {
  const loading = h('div', { id: 'loading' }, h('div', { class: 'spinner', style: 'width:22px;height:22px' }), 'Loading New York…');
  root.append(loading);
  await document.fonts.load('700 14px Overpass').catch(() => undefined);
  [world, land] = await Promise.all([fetchWorld(), fetchLand()]);
  loading.remove();
  await showTitle(root);
}

function freshMapContainer(root: HTMLElement): HTMLElement {
  root.querySelector('#map')?.remove();
  const el = h('div', { id: 'map' });
  root.prepend(el);
  return el;
}

async function showTitle(root: HTMLElement): Promise<void> {
  const view = await MapView.create(freshMapContainer(root));
  // A slow orbit over Midtown while you decide.
  view.map.jumpTo({ center: [-73.985, 40.752], zoom: 14.2, bearing: 20 });
  view.setView3D(true);
  let spinning = true;
  const spin = () => {
    if (!spinning) return;
    view.map.setBearing(view.map.getBearing() + 0.04);
    requestAnimationFrame(spin);
  };
  setTimeout(() => requestAnimationFrame(spin), 1200);

  const settings = loadSettings();
  setUnits(settings.units);
  const metas = await listSlots().catch(() => null);
  const auto = metas?.autosave ?? null;

  const start = (sandbox: boolean, save: SaveFile | null, tutorial: boolean) => {
    spinning = false;
    overlay.remove();
    view.resetFlat();
    view.map.jumpTo({ center: MAP.startCenter, zoom: MAP.startZoom, bearing: 0 });
    startGame(root, view, { sandbox: save ? save.game.sandbox : sandbox, save, tutorial });
  };

  const btn = (label: string, sub: string | null, onclick: () => void, primary = false) =>
    h('button', { class: `hw-btn ${primary ? 'primary' : ''}`, style: 'height:auto;padding:10px 14px;flex-direction:column;align-items:flex-start;gap:2px;width:100%', onclick }, h('span', { style: 'font-weight:800' }, label), sub ? h('span', { style: `font-size:12px;${primary ? '' : 'color:var(--muted)'};font-weight:400` }, sub) : null);

  const synthetic = world.meta.synthetic;
  const card = h(
    'div',
    { class: 'hw-panel', style: 'width:min(440px,calc(100vw - 32px));padding:26px 26px 20px' },
    h('div', { style: 'display:flex;align-items:center;gap:12px' }, h('span', { style: 'width:44px;height:44px;display:inline-flex' }, svgIcon(ICONS.logo)), h('div', null, h('div', { style: 'font-size:30px;font-weight:800;letter-spacing:.01em;line-height:1' }, 'Headway'), h('div', { class: 'hw-muted', style: 'font-size:15px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;margin-top:4px' }, 'New York'))),
    h('p', { style: 'line-height:1.55;margin:16px 0 18px' }, 'New York, but nobody ever built the subway. You get the real city, real commuting data for the five boroughs and a few billion dollars. Draw the lines — millions of New Yorkers decide whether they’re worth taking.'),
    h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:8px' },
      auto ? btn('Continue', `${fmtDate(auto.day)} · ${auto.sandbox ? 'Sandbox' : fmtMoney(auto.cash)} · ${fmtCount(auto.riders)} riders`, async () => { const s = await readSlot('autosave'); if (s) start(s.game.sandbox, s, false); }, true) : null,
      btn('New game', `$6B to start · bonds available · goals to chase`, () => chooseTutorial(false), !auto),
      btn('Sandbox', 'Unlimited money, instant construction', () => chooseTutorial(true)),
      btn('Load game', 'Saved slots or a file', () => loadDialog()),
      btn('Settings', null, () => settingsDialog()),
    ),
    h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:14px;line-height:1.45' }, synthetic ? '⚠ Running on a SYNTHETIC dataset — real LODES data was unreachable when the data was built.' : `Commuting data: ${world.meta.source}. ${fmtCount(world.tracts.reduce((s, t) => s + t.residents, 0))} commuters across ${world.tracts.length.toLocaleString()} census tracts.`),
  );
  const overlay = h('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-start;padding-left:max(16px,6vw);z-index:90;background:linear-gradient(90deg,rgba(16,20,25,.82),rgba(16,20,25,.25) 60%,rgba(16,20,25,0))' }, card);
  root.append(overlay);

  function chooseTutorial(sandbox: boolean) {
    let close: () => void = () => {};
    close = modal(
      root,
      h(
        'div',
        null,
        h('h2', null, sandbox ? 'New sandbox' : 'New game'),
        h('div', { class: 'hw-muted', style: 'line-height:1.5' }, 'Want a short walkthrough? It takes you from the jobs map to your first morning rush in eight steps.'),
        h('div', { class: 'actions' }, h('button', { class: 'hw-btn', onclick: () => { close(); start(sandbox, null, false); } }, 'Skip'), h('button', { class: 'hw-btn primary', onclick: () => { close(); start(sandbox, null, true); } }, 'Start with tutorial')),
      ),
    );
  }

  async function loadDialog() {
    const m = await listSlots();
    let close: () => void = () => {};
    const list = h('div', { class: 'list' });
    for (const slot of SLOTS) {
      const meta = m[slot];
      list.append(
        h(
          'div',
          { class: 'list-item', style: meta ? '' : 'opacity:.5;cursor:default', onclick: async () => { if (!meta) return; const s = await readSlot(slot); if (s) { close(); start(s.game.sandbox, s, false); } } },
          h('span', { class: 'grow' }, h('b', null, slot === 'autosave' ? 'Autosave' : `Slot ${slot.slice(-1)}`), h('div', { class: 'hw-muted', style: 'font-size:12px' }, meta ? `${fmtDate(meta.day)} · ${meta.sandbox ? 'Sandbox' : fmtMoney(meta.cash)} · ${new Date(meta.savedAt).toLocaleString()}` : 'Empty')),
        ),
      );
    }
    close = modal(
      root,
      h(
        'div',
        null,
        h('h2', null, 'Load game'),
        list,
        h('div', { class: 'actions' }, h('button', { class: 'hw-btn', onclick: async () => { try { const s = await importFile(); close(); start(s.game.sandbox, s, false); } catch (e) { alertBox((e as Error).message); } } }, 'Import file…'), h('button', { class: 'hw-btn', onclick: () => close() }, 'Cancel')),
      ),
    );
  }

  function alertBox(msg: string) {
    let close: () => void = () => {};
    close = modal(root, h('div', null, h('h2', null, 'Could not load'), h('div', { class: 'hw-muted' }, msg), h('div', { class: 'actions' }, h('button', { class: 'hw-btn primary', onclick: () => close() }, 'OK'))));
  }

  function settingsDialog() {
    let close: () => void = () => {};
    const s = loadSettings();
    const units = h('div', { class: 'seg' });
    const scale = h('div', { class: 'seg' });
    const render = () => {
      units.replaceChildren(...(['imperial', 'metric'] as const).map((u) => h('button', { class: s.units === u ? 'on' : '', onclick: () => { s.units = u; setUnits(u); storeSettings(s); render(); } }, u === 'imperial' ? 'Miles, mph' : 'Kilometres, km/h')));
      scale.replaceChildren(...COMMUTERS.agentScaleChoices.map((n) => h('button', { class: s.agentScale === n ? 'on' : '', onclick: () => { s.agentScale = n; storeSettings(s); render(); } }, `1 : ${n}`)));
    };
    render();
    close = modal(
      root,
      h(
        'div',
        null,
        h('h2', null, 'Settings'),
        h('div', { class: 'section' }, 'Units'),
        units,
        h('div', { class: 'section' }, 'Agent scale (real commuters per simulated agent)'),
        scale,
        h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:6px' }, 'Applies to new and loaded games. 1 : 10 simulates about 285,000 agents; 1 : 5 is twice as detailed and slower.'),
        h('div', { class: 'actions' }, h('button', { class: 'hw-btn primary', onclick: () => close() }, 'Done')),
      ),
    );
  }
}

function startGame(root: HTMLElement, view: MapView, p: { sandbox: boolean; save: SaveFile | null; tutorial: boolean }): void {
  const settings = loadSettings();
  current = new App(root, view, world, land, {
    sandbox: p.sandbox,
    save: p.save,
    settings: { ...settings, seed: p.save?.settings.seed ?? settings.seed },
    tutorial: p.tutorial,
    exit: () => {
      current = null;
      teardownUi(root);
      view.map.remove();
      showTitle(root);
    },
    restart: async (save) => {
      current?.destroy();
      current = null;
      teardownUi(root);
      view.map.remove();
      const v = await MapView.create(freshMapContainer(root));
      startGame(root, v, { sandbox: save.game.sandbox, save, tutorial: false });
    },
  });
  if (p.save) {
    // Put the camera over the network.
    const pts = [...current.game.network.nodes.values()].map((n) => toLonLat(n.x, n.y));
    if (pts.length) {
      const lons = pts.map((q) => q[0]), lats = pts.map((q) => q[1]);
      view.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 120, duration: 0, maxZoom: 13.5 });
    }
  }
  (window as unknown as { __headway?: unknown }).__headway = current;
}

function teardownUi(root: HTMLElement): void {
  for (const id of ['topbar', 'toolbar', 'tool-options', 'side', 'legend', 'blueprint-bar', 'toasts', 'busy', 'tutorial']) root.querySelector('#' + id)?.remove();
  root.querySelectorAll('.hw-tip, .modal-back').forEach((e) => e.remove());
  root.querySelectorAll('.hw-panel').forEach((e) => e.remove());
}

export function currentApp(): App | null {
  return current;
}
