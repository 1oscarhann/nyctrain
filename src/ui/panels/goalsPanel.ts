import { GOAL_DEFS } from '../../core/goals';
import { fmtDate } from '../../core/calendar';
import type { App } from '../app';
import { h } from '../dom';
import { shell, type Panel } from './common';

export function goalsPanel(app: App): Panel {
  const sh = shell('Progress', 'Goals', () => app.game.select(null));
  const done = GOAL_DEFS.filter((g) => app.goals[g.id] !== null).length;
  sh.body.append(h('div', { class: 'hw-muted', style: 'margin-bottom:8px' }, `${done} of ${GOAL_DEFS.length} complete. There's no hard win — keep moving more people, faster.`));
  const list = h('div', { class: 'list' });
  for (const g of GOAL_DEFS) {
    const day = app.goals[g.id];
    const ok = day !== null && day !== undefined;
    list.append(
      h(
        'div',
        { class: 'list-item', style: 'cursor:default;align-items:flex-start' },
        h('span', { style: `width:20px;height:20px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;${ok ? 'background:var(--green);color:#0f1a14' : 'border:1.5px solid var(--panel-line-strong)'}` }, ok ? '✓' : ''),
        h(
          'div',
          { class: 'grow', style: 'white-space:normal' },
          h('div', { style: 'font-weight:700' }, g.title, g.stretch ? h('span', { class: 'hw-amber', style: 'font-size:11px;margin-left:6px' }, 'STRETCH') : null),
          h('div', { class: 'hw-muted', style: 'font-size:12px' }, ok ? `Completed ${fmtDate(day!)}` : g.detail),
        ),
      ),
    );
  }
  sh.body.append(list);
  return { el: sh.el, dayEnd: () => app.refreshPanel() };
}
