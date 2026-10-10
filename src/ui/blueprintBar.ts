/**
 * Blueprint bar: appears while anything is planned. Shows length, stations, total cost and build
 * time, with Undo/Redo, Discard and Build.
 */
import { fmtDistance, fmtMoney } from '../core/units';
import type { App } from './app';
import { h, svgIcon } from './dom';
import { ICONS } from './icons';
import { attachTip } from './widgets';

export class BlueprintBar {
  readonly el = h('div', { id: 'blueprint-bar', class: 'hw-panel' });

  constructor(private app: App) {}

  update(): void {
    const game = this.app.game;
    if (!game.network.hasBlueprint()) {
      this.el.classList.remove('open');
      return;
    }
    const sum = game.blueprintSummary();
    const afford = game.finance.canAfford(sum.cost);
    const undo = h('button', { class: 'hw-btn ghost small', disabled: !game.history.canUndo(), onclick: () => game.undo() }, svgIcon(ICONS.undo));
    attachTip(undo, this.app.tooltip, 'Undo', 'Ctrl+Z');
    const redo = h('button', { class: 'hw-btn ghost small', style: 'transform:scaleX(-1)', disabled: !game.history.canRedo(), onclick: () => game.redo() }, svgIcon(ICONS.undo));
    attachTip(redo, this.app.tooltip, 'Redo', 'Ctrl+Shift+Z');
    const status = sum.invalid.length
      ? h('span', { class: 'hw-red', style: 'font-size:12.5px;max-width:320px;white-space:normal' }, `${sum.invalid.length} to fix: ${sum.invalid[0].reason}`)
      : !afford
        ? h('span', { class: 'hw-amber', style: 'font-size:12.5px' }, 'Not enough cash — issue a bond in Finances')
        : h('span', { class: 'hw-green', style: 'font-size:12.5px' }, 'Ready to build');
    const build = h(
      'button',
      {
        class: 'hw-btn primary',
        id: 'btn-build',
        disabled: sum.invalid.length > 0 || !afford,
        onclick: () => {
          const r = game.build();
          if (!r.ok) this.app.toast("Can't build yet", r.reason, 'red');
          else this.app.toast(game.sandbox ? 'Built' : 'Construction started', `${fmtMoney(r.cost ?? 0)} committed${game.sandbox ? '' : ` · about ${Math.ceil(sum.days)} days`}`, 'green');
        },
      },
      `Build · ${fmtMoney(sum.cost)}`,
    );
    const discard = h('button', { class: 'hw-btn ghost small', onclick: async () => { if (await this.app.confirm('Discard all blueprints?', 'Everything planned but not yet built will be removed. You can undo this.', 'Discard', true)) game.discardBlueprints(); } }, 'Discard');
    this.el.replaceChildren(
      h(
        'div',
        { style: 'display:flex;flex-direction:column;line-height:1.25' },
        h('span', { style: 'font-weight:700' }, 'Blueprint'),
        h('span', { class: 'hw-muted num', style: 'font-size:12.5px' }, `${fmtDistance(sum.length)} of track · ${sum.stations} station${sum.stations === 1 ? '' : 's'} · ${game.sandbox ? 'instant' : `${Math.ceil(sum.days)} days`}`),
      ),
      status,
      h('div', { style: 'display:flex;gap:4px' }, undo, redo, discard),
      build,
    );
    this.el.classList.add('open');
  }
}
