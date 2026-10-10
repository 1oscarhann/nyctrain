/** In-game menu: save to slots, export/import, load, settings, exit to title. */
import { COMMUTERS } from '../balance';
import { fmtDate } from '../core/calendar';
import { fmtMoney, setUnits } from '../core/units';
import { exportFile, importFile, listSlots, readSlot, SLOTS, type SlotId } from '../save/store';
import type { App } from './app';
import { h } from './dom';
import { modal } from './widgets';
import { storeSettings } from './settings';

const SLOT_LABEL: Record<SlotId, string> = { autosave: 'Autosave', slot1: 'Slot 1', slot2: 'Slot 2', slot3: 'Slot 3' };

export async function openMenu(app: App): Promise<void> {
  const metas = await listSlots();
  let close: () => void = () => {};
  const body = h('div');
  const slotRow = (slot: SlotId) => {
    const m = metas[slot];
    const info = m ? `${fmtDate(m.day)} · ${m.sandbox ? 'Sandbox' : fmtMoney(m.cash)} · saved ${new Date(m.savedAt).toLocaleString()}` : 'Empty';
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
              if (!(await app.confirm(`Load ${SLOT_LABEL[slot]}?`, 'Unsaved progress since the last autosave will be lost.', 'Load'))) return;
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
    h('div', { class: 'section' }, 'Units'),
    units,
    h('div', { class: 'section' }, 'Agent scale (real commuters per simulated agent)'),
    scale,
    h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:4px' }, 'Smaller is more detailed and slower. 1 : 10 simulates about 285,000 agents.'),
    h('div', { class: 'actions' }, h('button', { class: 'hw-btn', onclick: () => { close(); app.exitToTitle(); } }, 'Exit to title'), h('button', { class: 'hw-btn primary', onclick: () => close() }, 'Resume')),
  );
  close = modal(app.root, body);
}
