/** In-game menu: save to slots, export/import, load, city chaos level, city growth pace, settings, exit to title. */
import { CHAOS, COMMUTERS, GROWTH } from '../balance';
import { setUnits } from '../core/units';
import { exportFile, importFile, listSlots, readSlot, SLOTS, type SlotId } from '../save/store';
import { saveSummary } from '../save/summary';
import { CITIES, city } from '../cities';
import type { App } from './app';
import { h } from './dom';
import { modal } from './widgets';
import { LEVEL_HINT, LEVEL_LABEL } from './alertFeed';
import { GROWTH_PACE_HINT, GROWTH_PACE_LABEL } from './livingCity';
import { storeSettings } from './settings';

const SLOT_LABEL: Record<SlotId, string> = { autosave: 'Autosave', slot1: 'Slot 1', slot2: 'Slot 2', slot3: 'Slot 3' };

export async function openMenu(app: App): Promise<void> {
  const metas = await listSlots();
  let close: () => void = () => {};
  const body = h('div');
  const slotRow = (slot: SlotId) => {
    const m = metas[slot];
    const info = m ? `${saveSummary(m)} · saved ${new Date(m.savedAt).toLocaleString()}` : 'Empty';
    return h(
      'div',
      { class: 'list-item', style: 'cursor:default' },
      h('span', { class: 'grow' }, h('b', null, SLOT_LABEL[slot]), h('div', { class: 'hw-muted', style: 'font-size:12px' }, info)),
      slot !== 'autosave'
        ? h('button', {
            class: 'hw-btn small',
            onclick: async () => {
              const ok = await app.saveWithFreshModeState(slot, SLOT_LABEL[slot]);
              app.toast(ok ? 'Saved' : 'Save failed', ok ? SLOT_LABEL[slot] : 'Storage unavailable', ok ? 'green' : 'red');
              close();
            },
          }, 'Save here')
        : null,
      m
        ? h('button', {
            class: 'hw-btn small',
            onclick: async () => {
              const save = await readSlot(slot);
              if (!save) return app.toast('Could not read save', undefined, 'red');
              const other = m.city && m.city !== city().id ? ` This save is in ${CITIES[m.city].name}; the game switches city.` : '';
              if (!(await app.confirm(`Load ${SLOT_LABEL[slot]}?`, `Unsaved progress since the last autosave will be lost.${other}`, 'Load'))) return;
              close();
              app.opts.restart(save);
            },
          }, 'Load')
        : null,
    );
  };
  const units = h('div', { class: 'seg' });
  const renderUnits = () => {
    units.replaceChildren(
      ...(['imperial', 'metric'] as const).map((u) =>
        h('button', { class: app.settings.units === u ? 'on' : '', onclick: () => { app.settings.units = u; setUnits(u); storeSettings(app.settings); renderUnits(); app.refreshPanel(); app.toolbar.update(); } }, u === 'imperial' ? 'Miles, mph' : 'Kilometres, km/h'),
      ),
    );
  };
  renderUnits();
  // City chaos level for this game (applies from the next 3 am).
  const chaos = h('div', { class: 'seg' });
  const chaosHint = h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:4px' });
  const renderChaos = () => {
    chaos.replaceChildren(
      ...CHAOS.levels.map((l) => h('button', { class: app.game.chaos.level === l ? 'on' : '', title: LEVEL_HINT[l], onclick: () => { if (l !== app.game.chaos.level) app.setChaosLevel(l); renderChaos(); } }, LEVEL_LABEL[l])),
    );
    chaosHint.textContent = `${LEVEL_HINT[app.game.chaos.level]}. Changes apply from 3 am; Service alerts (A) shows what is happening.`;
  };
  renderChaos();
  // Living City pace for this game (applies from the next month end).
  const pace = h('div', { class: 'seg', id: 'menu-growth' });
  const paceHint = h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:4px' });
  const renderPace = () => {
    pace.replaceChildren(
      ...GROWTH.paces.map((p) => h('button', { class: app.game.growthPace === p ? 'on' : '', 'data-pace': p, title: GROWTH_PACE_HINT[p], onclick: () => { if (p !== app.game.growthPace) app.setGrowthPace(p); renderPace(); } }, GROWTH_PACE_LABEL[p])),
    );
    paceHint.textContent = `${GROWTH_PACE_HINT[app.game.growthPace]}. Takes effect at the next month end; G shows the growth map.`;
  };
  renderPace();
  const scale = h('div', { class: 'seg' });
  for (const s of COMMUTERS.agentScaleChoices) {
    scale.append(
      h('button', {
        class: app.settings.agentScale === s ? 'on' : '',
        onclick: async () => {
          if (s === app.settings.agentScale) return;
          if (!(await app.confirm('Change agent scale?', `Each simulated commuter will represent ${s} real people. The simulation restarts from your current state; commuters re-learn their habits over a few days.`, 'Restart simulation'))) return;
          app.settings.agentScale = s;
          storeSettings(app.settings);
          close();
          app.opts.restart(app.buildSave('Autosave'));
        },
      }, `1 : ${s}`),
    );
  }
  body.append(
    h('h2', null, 'Menu'),
    h('div', { class: 'section' }, 'Saves'),
    h('div', { class: 'list' }, ...SLOTS.map(slotRow)),
    h(
      'div',
      { style: 'display:flex;gap:6px;margin-top:8px' },
      h('button', { class: 'hw-btn small', onclick: async () => { await app.saveWithFreshModeState('autosave'); exportFile(app.buildSave('Exported game')); } }, 'Export to file'),
      h('button', {
        class: 'hw-btn small',
        onclick: async () => {
          try {
            const save = await importFile();
            close();
            app.opts.restart(save);
          } catch (e) {
            app.toast('Import failed', (e as Error).message, 'red');
          }
        },
      }, 'Import file'),
    ),
    h('div', { class: 'section' }, 'City chaos (events, disruptions, weather)'),
    chaos,
    chaosHint,
    h('div', { class: 'section' }, 'City growth (neighbourhoods grow around good transit)'),
    pace,
    paceHint,
    h('div', { class: 'section' }, 'Units'),
    units,
    h('div', { class: 'section' }, 'Agent scale (real commuters per simulated agent)'),
    scale,
    h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:4px' }, 'Smaller is more detailed and slower. 1 : 10 simulates about 285,000 agents.'),
    h('div', { class: 'actions' }, h('button', { class: 'hw-btn', onclick: () => { close(); app.exitToTitle(); } }, 'Exit to title'), h('button', { class: 'hw-btn primary', onclick: () => close() }, 'Resume')),
  );
  close = modal(app.root, body);
}
