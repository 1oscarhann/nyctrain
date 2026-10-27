/**
 * Skippable tutorial for a new company: find the jobs, draw a line with the Line tool, build it,
 * set its trains, watch the rush, then keep stations moving and the money in check. Each step
 * advances when its condition is met (or on Next).
 */
import { city } from '../cities';
import { fmtMoney } from '../core/units';
import type { App } from './app';
import { h } from './dom';

interface Step {
  title: string | ((app: App) => string);
  body: string | ((app: App) => string);
  done?: (app: App) => boolean;
}

const STEPS: Step[] = [
  {
    title: (a) => (a.game.company ? `${a.game.company.name} is open` : 'Where do people work?'),
    body: (a) => `${a.game.company && a.game.company.grant > 0 ? `The government's ${fmtMoney(a.game.company.grant)} start-up grant is in the bank. Spend it where the jobs are. ` : ''}${city().tutorial.jobs}`,
    done: (a) => a.overlays.mode === 'jobs',
  },
  {
    title: 'Draw your first line',
    body: () => `${city().tutorial.line} Red means something to fix; the bar at the bottom says what.`,
    done: (a) => a.game.routes.list().length > 0,
  },
  {
    title: 'Build it',
    body: (a) => `Press Build in the blueprint bar at the bottom. That spends the money and starts the works${a.game.sandbox ? ' (instant in Sandbox)' : ': each piece takes days of game time, and the trains start once everything is finished'}.`,
    done: (a) => [...a.game.network.edges.values()].some((e) => e.status !== 'blueprint'),
  },
  {
    title: 'Set the trains',
    body: 'Press N for Routes & stations (or click your line). − and + run trains more or less often in each part of the day and make them longer or shorter. Hover a button to see what it costs; changes apply at once and buy the trains they need.',
    done: (a) => a.game.selection?.kind === 'routes' || a.game.selection?.kind === 'route',
  },
  {
    title: 'Watch the morning rush',
    body: 'Speed up with keys 1–4 or skip to 6am. Riders start using a line the day it opens and more switch over each day as habits change. The rush runs from about 6 to 10.',
    done: (a) => (a.sim.latest?.live.ridersToday ?? 0) > 0,
  },
  {
    title: 'Open a station',
    body: 'Click a station to see its boardings by hour, where riders come from and go to (drawn on the map), and how full it gets.',
    done: (a) => a.game.selection?.kind === 'station',
  },
  {
    title: 'Keep the gates open',
    body: 'A station packed past twice what it holds shuts its gates and turns people away, and they take a cab instead. N → Stations shows how full each one got yesterday: upgrade the crowded ones (bigger concourses, faster boarding, quicker changes), or run longer, more frequent trains.',
  },
  {
    title: 'Make it pay',
    body: 'Fares come in with every ride; trains, staff and track upkeep go out every day. Check Finances for the daily money, issue a bond if you need to build big, and see Goals for what to aim for next.',
  },
];

export class Tutorial {
  private step = 0;
  private el: HTMLElement;
  private timer: number;

  constructor(private app: App, private onDone: () => void) {
    this.el = h('div', { class: 'hw-panel', id: 'tutorial', style: 'position:absolute;left:50%;transform:translateX(-50%);bottom:108px;width:min(460px,calc(100vw - 32px));padding:14px 16px;z-index:35;border-left:3px solid var(--amber)' });
    app.root.append(this.el);
    this.render();
    this.timer = window.setInterval(() => this.poke(), 500);
  }

  poke(): void {
    const s = STEPS[this.step];
    if (s?.done?.(this.app)) this.next();
  }

  private next(): void {
    this.step++;
    if (this.step >= STEPS.length) {
      this.finish();
      return;
    }
    this.render();
  }

  private finish(): void {
    this.app.toast('Tutorial complete', 'Keep building — check Goals for what to aim for next.', 'green');
    this.close();
  }

  close(): void {
    clearInterval(this.timer);
    this.el.remove();
    this.onDone();
  }

  private render(): void {
    const s = STEPS[this.step];
    this.el.replaceChildren(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px' }, h('span', { class: 'hw-amber', style: 'font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700' }, `Tutorial · ${this.step + 1} of ${STEPS.length}`), h('button', { class: 'hw-btn ghost small', onclick: () => this.close() }, 'Skip tutorial')),
      h('div', { style: 'font-weight:800;font-size:15px;margin-bottom:4px' }, typeof s.title === 'function' ? s.title(this.app) : s.title),
      h('div', { class: 'hw-muted', style: 'line-height:1.5' }, typeof s.body === 'function' ? s.body(this.app) : s.body),
      h('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, h('button', { class: s.done ? 'hw-btn small' : 'hw-btn primary small', onclick: () => this.next() }, s.done ? 'Skip step' : 'Next')),
    );
  }
}
