import { GROWTH } from '../../balance';
import { goalDefs } from '../../core/goals';
import { fmtDate } from '../../core/calendar';
import { tractGrowthSince } from '../../map/growthMath';
import type { App } from '../app';
import { h } from '../dom';
import { growthGoalProgress } from '../livingCity';
import { shell, type Panel } from './common';

/** Living City goals' progress: the best tract so far (≥ GROWTH.minTractPeople) and the best month's value capture. */
function growthProgress(app: App): { best: { tract: number; growth: number } | null; bestMonth: number } {
  const v = app.growthView;
  let best: { tract: number; growth: number } | null = null;
  if (v) {
    for (const t of app.world.tracts) {
      if (t.residents + t.jobs < GROWTH.minTractPeople) continue;
      const u = tractGrowthSince(t, v);
      if (!best || u > best.growth) best = { tract: t.index, growth: u };
    }
  }
  const bestMonth = Math.max(0, ...app.game.finance.months.map((m) => m.valueCapture ?? 0));
  return { best, bestMonth };
}

export function goalsPanel(app: App): Panel {
  const sh = shell('Progress', 'Goals', () => app.game.select(null));
  const defs = goalDefs();
  const done = defs.filter((g) => app.goals[g.id] !== null).length;
  sh.body.append(h('div', { class: 'hw-muted', style: 'margin-bottom:8px' }, `${done} of ${defs.length} complete. There's no hard win — keep moving more people, faster.`));
  const list = h('div', { class: 'list goal-grid' });
  const gp = growthProgress(app);
  // The growth view arrives once (it is cached); then the panel redraws with the progress lines.
  if (!app.growthView) app.loadGrowthView().then((v) => v && app.game.selection?.kind === 'goals' && app.refreshPanel());
  for (const g of defs) {
    const day = app.goals[g.id];
    const ok = day !== null && day !== undefined;
    const progress =
      ok || (g.id !== 'boomtown' && g.id !== 'value-capture')
        ? null
        : g.id === 'value-capture' && app.game.sandbox
          ? 'Counts outside the sandbox only.'
          : growthGoalProgress(g.id, gp.best, gp.bestMonth, app.game.growthPace, (i) => app.tractName(i));
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
          progress ? h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:2px' }, progress) : null,
        ),
      ),
    );
  }
  sh.body.append(list);
  return { el: sh.el, full: true, dayEnd: () => app.refreshPanel() };
}
