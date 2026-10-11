/**
 * Skippable 8-step tutorial. Each step advances when its condition is met (or on Next).
 */
import { city } from '../cities';
import type { App } from './app';
import { h } from './dom';

interface Step {
  title: string;
  body: string | (() => string);
  done?: (app: App) => boolean;
}

const STEPS: Step[] = [
  {
    title: 'Where do people work?',
    body: () => city().tutorial.jobs,
    done: (a) => a.overlays.mode === 'jobs',
  },
  {
    title: 'Draw some track',
    body: () => `${city().tutorial.track} Red segments tell you what to fix.`,
    done: (a) => a.game.network.edges.size > 0,
  },
  {
    title: 'Place stations',
    body: 'Press S and click on your track to place at least two stations. They need straight, level track and 400 m between them. The faint circle is the 800 m walking catchment.',
    done: (a) => a.game.network.stations.size >= 2,
  },
  {
    title: 'Build it',
    body: 'Press Build in the blueprint bar at the bottom. That spends the money and starts construction — each piece takes days of game time (instant in Sandbox).',
    done: (a) => [...a.game.network.edges.values()].some((e) => e.status !== 'blueprint'),
  },
  {
    title: 'Create a route',
    body: 'Press R and click your stations in order, then Create route. You can do this while construction is still going — trains start once everything is built.',
    done: (a) => a.game.routes.list().length > 0,
  },
  {
    title: 'Set its frequency',
    body: 'The route panel shows how often trains run in each period. Faster service means shorter waits but more trains to buy. Change it and press Apply, or keep the defaults.',
  },
  {
    title: 'Watch the morning rush',
    body: 'Speed up with keys 1–4 or skip to 6am. Every day at 3am commuters decide whether your line beats driving or walking, and the rush runs from about 6 to 10.',
    done: (a) => (a.sim.latest?.live.ridersToday ?? 0) > 0,
  },
  {
    title: 'Open a station',
    body: 'Click a station to see its boardings by hour, where riders come from and go to (drawn on the map), and how crowded it gets.',
    done: (a) => a.game.selection?.kind === 'station',
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
      h('div', { style: 'font-weight:800;font-size:15px;margin-bottom:4px' }, s.title),
      h('div', { class: 'hw-muted', style: 'line-height:1.5' }, typeof s.body === 'function' ? s.body() : s.body),
      h('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, h('button', { class: s.done ? 'hw-btn small' : 'hw-btn primary small', onclick: () => this.next() }, s.done ? 'Skip step' : 'Next')),
    );
  }
}
