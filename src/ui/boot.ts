/**
 * Startup: pick a city, load its data, show the title screen (over a slowly turning 3D skyline),
 * start games. Switching city re-applies the city's balance, origin and currency (cities/index.ts)
 * and reloads its data (cached per city).
 */
import { ECONOMY, MAP, COMMUTERS, type ChaosLevel, type CityId } from '../balance';
import { applyCity, CITIES, CITY_IDS, city, cityBalance } from '../cities';
import { toLonLat } from '../core/geo';
import { currency, fmtCount, setUnits } from '../core/units';
import { fetchLand, fetchWorld, type LandCollection, type World } from '../data/world';
import { foundCompany } from './founding';
import type { Company } from '../core/company';
import { MapView } from '../map/mapView';
import type { SaveFile } from '../save/format';
import { importFile, listSlots, readSlot, SLOTS } from '../save/store';
import { saveSummary } from '../save/summary';
import { App } from './app';
import { h, svgIcon } from './dom';
import { ICONS } from './icons';
import { loadChaosLevel, loadLastCity, loadSettings, storeChaosLevel, storeLastCity, storeSettings, storeUnits } from './settings';
import { LEVEL_HINT, LEVEL_LABEL } from './alertFeed';
import { modal } from './widgets';
import { titleLight } from '../cinematic';
import { DAY_NIGHT_HINT, DAY_NIGHT_LABEL, loadPrefs, storePrefs } from '../cinematic/prefs';

let world: World;
let land: LandCollection;
let current: App | null = null;
/** The metro city to go back to from Intertown. */
let lastMetro: CityId = 'london';
const cache = new Map<CityId, { world: World; land: LandCollection }>();

/** Make `id` the current city: balance overrides, origin, currency, then its (cached) data. */
async function useCity(root: HTMLElement, id: CityId): Promise<void> {
  applyCity(id);
  document.title = `Headway: ${city().name}`;
  let d = cache.get(id);
  if (!d) {
    const loading = h('div', { id: 'loading' }, h('div', { class: 'spinner', style: 'width:22px;height:22px' }), `Loading ${city().name}…`);
    root.append(loading);
    try {
      const base = new URL(city().dataPath, document.baseURI).href;
      const [w, l] = await Promise.all([fetchWorld(base), fetchLand(base)]);
      d = { world: w, land: l };
      cache.set(id, d);
    } catch (e) {
      // Callers fall back to the previous city (or main.ts shows "Failed to start").
      loading.remove();
      throw e;
    }
    loading.remove();
  }
  world = d.world;
  land = d.land;
}

/** Switch to `id`, or stay in (and re-apply) `back` if its data can't be loaded. Returns an error notice or null. */
async function useCityOr(root: HTMLElement, id: CityId, back: CityId): Promise<string | null> {
  try {
    await useCity(root, id);
    storeLastCity(id);
    return null;
  } catch (e) {
    console.error(e);
    await useCity(root, back);
    return `Couldn’t load ${CITIES[id].name}: ${(e as Error).message}`;
  }
}

export async function bootstrap(root: HTMLElement): Promise<void> {
  await document.fonts.load('700 14px Overpass').catch(() => undefined);
  const want = loadLastCity();
  // New York is the fallback; if New York itself fails, main.ts reports it.
  const notice = want === 'nyc' ? (await useCity(root, 'nyc'), null) : await useCityOr(root, want, 'nyc');
  await showTitle(root, notice);
}

function freshMapContainer(root: HTMLElement): HTMLElement {
  root.querySelector('#map')?.remove();
  const el = h('div', { id: 'map' });
  root.prepend(el);
  return el;
}

async function showTitle(root: HTMLElement, notice: string | null = null): Promise<void> {
  const view = await MapView.create(freshMapContainer(root));
  // Cinematic: blue hour over the skyline, windows lit (Always day: the plain map); a game takes the light over.
  titleLight(view.map);
  // A slow orbit over the city's centre while you decide.
  const cam = cityBalance().titleCamera;
  view.map.jumpTo({ center: cam.center, zoom: cam.zoom, bearing: cam.bearing });
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

  const leave = () => {
    spinning = false;
    overlay.remove();
  };

  const switchCity = async (id: CityId) => {
    if (id === city().id) return;
    const back = city().id;
    leave();
    view.destroy();
    await showTitle(root, await useCityOr(root, id, back));
  };

  const start = async (sandbox: boolean, save: SaveFile | null, tutorial: boolean, chaos?: ChaosLevel, company?: Omit<Company, 'founded'>) => {
    leave();
    let v = view;
    if (save && save.city !== city().id) {
      // A save from the other city: switch over first.
      const back = city().id;
      v.destroy();
      const err = await useCityOr(root, save.city, back);
      if (err) return showTitle(root, err);
      v = await MapView.create(freshMapContainer(root));
    } else {
      v.resetFlat();
    }
    v.map.jumpTo({ center: MAP.startCenter, zoom: MAP.startZoom, bearing: 0 });
    startGame(root, v, { sandbox: save ? save.game.sandbox : sandbox, save, tutorial, chaos, company });
  };

  const btn = (label: string, sub: string | null, onclick: () => void, primary = false) =>
    h('button', { class: `hw-btn ${primary ? 'primary' : ''}`, style: 'height:auto;padding:10px 14px;flex-direction:column;align-items:flex-start;gap:2px;width:100%', onclick }, h('span', { style: 'font-weight:800' }, label), sub ? h('span', { style: `font-size:12px;${primary ? '' : 'color:var(--muted)'};font-weight:400` }, sub) : null);

  const c = city();
  const synthetic = world.meta.synthetic;
  // Two modes: Metro (a city's subway: New York or London) and Intertown (regional rail: the South
  // East, with a New York region to come). The mode follows the city.
  const intertown = c.intertown === true;
  if (!intertown) lastMetro = c.id;
  const metroIds = CITY_IDS.filter((id) => !CITIES[id].intertown);
  const interIds = CITY_IDS.filter((id) => CITIES[id].intertown);
  const modePicker = h(
    'div',
    { class: 'seg mode-seg', style: 'margin:16px 0 0;width:100%;display:flex' },
    h('button', { class: !intertown ? 'on' : '', style: 'flex:1', title: 'Build a subway inside one city', onclick: () => switchCity(lastMetro) }, h('b', null, 'Metro'), h('span', { class: 'mode-sub' }, 'one city, underground')),
    h('button', { class: intertown ? 'on' : '', style: 'flex:1', title: 'Build regional rail between towns', onclick: () => switchCity(interIds[0]) }, h('b', null, 'Intertown'), h('span', { class: 'mode-sub' }, 'regional rail, high speed')),
  );
  const cityPicker = h(
    'div',
    { class: 'seg', style: 'margin:8px 0 0;width:100%;display:flex' },
    ...(intertown ? interIds : metroIds).map((id) => h('button', { class: id === c.id ? 'on' : '', style: 'flex:1', onclick: () => switchCity(id), title: `Play in ${CITIES[id].name}` }, intertown ? `${CITIES[id].name} · from Victoria` : CITIES[id].name)),
    intertown ? h('button', { disabled: true, style: 'flex:1', title: 'Coming later' }, 'New York region · soon') : null,
  );
  const card = h(
    'div',
    { class: 'hw-panel', style: 'width:min(440px,calc(100vw - 32px));padding:26px 26px 20px' },
    h('div', { style: 'display:flex;align-items:center;gap:12px' }, h('span', { style: 'width:44px;height:44px;display:inline-flex' }, svgIcon(ICONS.logo)), h('div', null, h('div', { style: 'font-size:30px;font-weight:800;letter-spacing:.01em;line-height:1' }, 'Headway'), h('div', { class: 'hw-muted', style: 'font-size:15px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;margin-top:4px' }, c.name))),
    modePicker,
    cityPicker,
    h('p', { style: 'line-height:1.55;margin:14px 0 18px' }, c.blurb),
    h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:8px' },
      auto ? btn('Continue', `${saveSummary(auto)} · ${fmtCount(auto.riders)} riders`, async () => { const s = await readSlot('autosave'); if (s) start(s.game.sandbox, s, false); }, true) : null,
      btn('New game', `${currency()}${+(ECONOMY.startingCash / 1e9).toFixed(1)}B to start · bonds available · goals to chase`, () => chooseTutorial(false), !auto),
      btn('Sandbox', 'Unlimited money, instant construction', () => chooseTutorial(true)),
      btn('Load game', 'Saved slots or a file', () => loadDialog()),
      btn('Settings', null, () => settingsDialog()),
    ),
    notice ? h('div', { class: 'err', style: 'margin-top:12px' }, notice) : null,
    h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:14px;line-height:1.45' }, synthetic ? '⚠ Running on a SYNTHETIC dataset — real commuting data was unreachable when the data was built.' : `Commuting data: ${world.meta.source}. ${fmtCount(world.tracts.reduce((s, t) => s + t.residents, 0))} commuters across ${world.tracts.length.toLocaleString()} ${c.zoneWord}.`),
  );
  const overlay = h('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-start;padding-left:max(16px,6vw);z-index:90;background:linear-gradient(90deg,rgba(16,20,25,.82),rgba(16,20,25,.25) 60%,rgba(16,20,25,0))' }, card);
  root.append(overlay);

  async function chooseTutorial(sandbox: boolean) {
    // Found the company: name, logo, the government's start-up grant, city chaos and the tutorial.
    const r = await foundCompany(root, { sandbox, chaos: loadChaosLevel(), levelLabels: LEVEL_LABEL, levelHints: LEVEL_HINT });
    if (!r) return;
    storeChaosLevel(r.chaos);
    start(sandbox, null, r.tutorial, r.chaos, r.company);
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
          h('span', { class: 'grow' }, h('b', null, slot === 'autosave' ? 'Autosave' : `Slot ${slot.slice(-1)}`), h('div', { class: 'hw-muted', style: 'font-size:12px' }, meta ? `${saveSummary(meta)} · ${new Date(meta.savedAt).toLocaleString()}` : 'Empty')),
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
    // Cinematic: day and night, lit windows (per viewer, never in a save).
    const dayNight = h('div', { class: 'seg', id: 'set-daynight' });
    const windows = h('div', { class: 'seg', id: 'set-windows' });
    const dnHint = h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:6px' });
    const render = () => {
      units.replaceChildren(...(['imperial', 'metric'] as const).map((u) => h('button', { class: s.units === u ? 'on' : '', onclick: () => { s.units = u; setUnits(u); storeUnits(u); render(); } }, u === 'imperial' ? 'Miles, mph' : 'Kilometres, km/h')));
      scale.replaceChildren(...COMMUTERS.agentScaleChoices.map((n) => h('button', { class: s.agentScale === n ? 'on' : '', onclick: () => { s.agentScale = n; storeSettings(s); render(); } }, `1 : ${n}`)));
      const cp = loadPrefs();
      dayNight.replaceChildren(...(['cycle', 'day', 'light'] as const).map((m) => h('button', { class: cp.dayNight === m ? 'on' : '', title: DAY_NIGHT_HINT[m], onclick: () => { storePrefs({ dayNight: m }); titleLight(view.map); render(); } }, DAY_NIGHT_LABEL[m])));
      windows.replaceChildren(...([true, false] as const).map((on) => h('button', { class: cp.windows === on ? 'on' : '', disabled: cp.dayNight !== 'cycle', onclick: () => { storePrefs({ windows: on }); render(); } }, on ? 'Lit windows' : 'Dark')));
      dnHint.textContent = `${DAY_NIGHT_HINT[cp.dayNight]}.`;
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
        h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:6px' }, 'Applies to new and loaded games. 1 : 10 simulates about 285,000 agents; 1 : 5 is twice as detailed and slower. Intertown runs at 1 : 20 or coarser.'),
        h('div', { class: 'section' }, 'Light'),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, dayNight, windows),
        dnHint,
        h('div', { class: 'actions' }, h('button', { class: 'hw-btn primary', onclick: () => close() }, 'Done')),
      ),
    );
  }
}

function startGame(root: HTMLElement, view: MapView, p: { sandbox: boolean; save: SaveFile | null; tutorial: boolean; chaos?: ChaosLevel; company?: Omit<Company, 'founded'> }): void {
  const settings = loadSettings();
  // Intertown has 6.35M commuters (twice a metro city): at least 1 : 20 keeps the agent count where New York's is at 1 : 10.
  if (city().intertown) settings.agentScale = Math.max(settings.agentScale, 20);
  current = new App(root, view, world, land, {
    sandbox: p.sandbox,
    save: p.save,
    chaos: p.chaos,
    company: p.company,
    settings: { ...settings, seed: p.save?.settings.seed ?? settings.seed },
    tutorial: p.tutorial,
    exit: () => {
      current = null;
      teardownUi(root);
      view.destroy();
      showTitle(root);
    },
    restart: async (save) => {
      current?.destroy();
      current = null;
      teardownUi(root);
      view.destroy();
      if (save.city !== city().id) {
        const err = await useCityOr(root, save.city, city().id);
        if (err) return void showTitle(root, err);
      }
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
