/**
 * The title screen: the trailer's animation playing full screen behind everything (no captions:
 * the captioned trailer is a separate video), a "press any key" card that also starts the music,
 * then the menu as a metro line down the left edge, each option a station, an amber train sliding
 * to the one you point at (mouse, or arrow keys and Enter). New game and Sandbox branch to the
 * maps; picking one cuts the animation to that city.
 */
import type { CityId } from '../balance';
import { CITIES } from '../cities';
import { h } from './dom';
import { TitleTrailer } from './titleTrailer';
import type { SceneData } from './titleData';

type Scene = SceneData & { commuters: number; areas: number; source: string };

/** The maps, in the order the animation plays them. */
const MAPS: { id: CityId; mode: string }[] = [
  { id: 'london', mode: 'Metro' },
  { id: 'nyc', mode: 'Metro' },
  { id: 'manchester', mode: 'Metro' },
  { id: 'birmingham', mode: 'Metro' },
  { id: 'leeds', mode: 'Metro' },
  { id: 'bristol', mode: 'Metro' },
  { id: 'southeast', mode: 'Regional rail' },
];

const MUSIC_KEY = 'headway-title-music';
const MUSIC_VOLUME = 0.6;

function musicPref(): boolean {
  try {
    return localStorage.getItem(MUSIC_KEY) !== 'off';
  } catch {
    return true;
  }
}

export interface TitleActions {
  /** The autosave's one-line summary, or null when there is none. */
  continueSummary: string | null;
  onContinue: () => void;
  /** A map picked for a new game (sandbox or not). */
  onNew: (city: CityId, sandbox: boolean) => void;
  onLoad: () => void;
  onSettings: () => void;
  /** A problem to show under the menu (a map that failed to load). */
  notice?: string | null;
  /** Skip the press-any-key card (coming back from a game). */
  skipCard?: boolean;
}

type Item = { id: string; lbl: string; sub?: string; small?: boolean; go?: boolean };

export class TitleScreen {
  readonly el: HTMLElement;
  private trailer: TitleTrailer | null = null;
  private scenes: Record<string, Scene> | null = null;
  private music: HTMLAudioElement;
  private musicOn = musicPref();
  private fadeRaf = 0;
  private screen: 'home' | 'maps' = 'home';
  private sandbox = false;
  private sel = 0;
  private picked: CityId = 'london';
  private open = false;
  private stops: HTMLUListElement;
  private kicker: HTMLElement;
  private reel: HTMLElement;
  private soundBtn: HTMLButtonElement;
  private destroyed = false;
  private lastCity = '';
  private raf = 0;
  private readonly reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(
    root: HTMLElement,
    private actions: TitleActions,
  ) {
    const canvas = h('canvas', { class: 'tt-scene', 'aria-hidden': 'true' }) as HTMLCanvasElement;
    this.stops = h('ul', { class: 'tt-stops' }) as HTMLUListElement;
    this.kicker = h('div', { class: 'tt-kicker' });
    this.reel = h('div', { class: 'tt-reel tt-ui', 'aria-label': 'Now showing' });
    this.soundBtn = h(
      'button',
      { class: 'tt-sound tt-ui', type: 'button', 'aria-pressed': String(this.musicOn), onclick: (e: Event) => { e.stopPropagation(); this.setMusic(!this.musicOn, true); } },
      h('span', { class: 'tt-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', null, 'Music ', h('b', null, this.musicOn ? 'on' : 'off')),
      h('span', { class: 'tt-credit' }, 'Lights at Night · Tsorthan Grove · CC0'),
    ) as HTMLButtonElement;
    this.el = h(
      'div',
      { id: 'title' },
      canvas,
      h('div', { class: 'tt-scrim' }),
      h('div', { class: 'tt-card' }, h('h2', null, 'Head', h('span', null, '·'), 'way'), h('p', null, 'Press any key')),
      h('h1', { class: 'tt-word tt-ui' }, 'Head', h('span', null, '·'), 'way'),
      h('nav', { class: 'tt-nav tt-ui', 'aria-label': 'Main menu' }, this.kicker, this.stops, actions.notice ? h('div', { class: 'tt-notice' }, actions.notice) : null),
      this.reel,
      this.soundBtn,
    );
    root.append(this.el);
    this.music = new Audio(new URL('audio/title-lights-at-night.mp3', document.baseURI).href);
    this.music.loop = true;
    this.music.volume = 0;
    this.music.preload = 'auto';
    window.addEventListener('keydown', this.onKey, true);
    this.el.addEventListener('pointerdown', this.onPointer);
    fetch(new URL('data/title-scenes.json', document.baseURI).href)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, Scene>>) : null))
      .then((s) => {
        if (!s || this.destroyed) return;
        this.scenes = s;
        this.trailer = new TitleTrailer(canvas, MAPS.filter((m) => s[m.id]).map((m) => ({ id: m.id, data: s[m.id] })), {
          focusX: () => (this.open && window.innerWidth > 760 ? 0.62 : 0.5),
          letterbox: () => (this.open ? 0.075 : 0.1),
          reducedMotion: this.reduced,
        });
        this.render();
        this.tick();
      })
      .catch(() => undefined);
    if (actions.skipCard || this.reduced) this.start(false);
  }

  /** Fade the music out and take the screen down (a game is starting). */
  leave(): void {
    this.fadeMusic(0, 0.9);
    this.el.classList.add('tt-leaving');
    setTimeout(() => this.destroy(), 950);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.fadeRaf);
    cancelAnimationFrame(this.raf);
    this.music.pause();
    this.trailer?.destroy();
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
  }

  // ------------------------------------------------------------------ music
  private setMusic(on: boolean, remember: boolean): void {
    this.musicOn = on;
    this.soundBtn.setAttribute('aria-pressed', String(on));
    this.soundBtn.querySelector('b')!.textContent = on ? 'on' : 'off';
    if (remember) {
      try {
        localStorage.setItem(MUSIC_KEY, on ? 'on' : 'off');
      } catch {
        /* not remembered */
      }
    }
    if (on) this.music.play().then(() => this.fadeMusic(MUSIC_VOLUME, 3)).catch(() => undefined);
    else this.fadeMusic(0, 0.8);
  }

  private fadeMusic(to: number, secs: number): void {
    cancelAnimationFrame(this.fadeRaf);
    const from = this.music.volume, t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / (secs * 1000));
      this.music.volume = from + (to - from) * k;
      if (k < 1) this.fadeRaf = requestAnimationFrame(step);
      else if (to === 0) this.music.pause();
    };
    step();
  }

  // ------------------------------------------------------------------ press any key, then the menu
  private start(withMusic = true): void {
    if (this.open) return;
    this.open = true;
    this.el.classList.add('tt-open');
    if (withMusic && this.musicOn) this.setMusic(true, false);
    this.sel = this.actions.continueSummary ? 0 : 1;
    this.render();
  }

  private onPointer = (): void => {
    if (!this.open) this.start();
  };

  private onKey = (e: KeyboardEvent): void => {
    // A dialog over the title (founding, load, settings) has the keyboard.
    if (document.querySelector('.modal-back')) return;
    if (!this.open) {
      if (e.key === 'Tab') return;
      e.preventDefault();
      this.start();
      return;
    }
    const items = this.items();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      this.mark();
      this.stops.querySelectorAll<HTMLButtonElement>('.tt-stop')[this.sel]?.focus();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      this.choose(items[this.sel]);
    } else if (e.key === 'Escape' && this.screen === 'maps') {
      e.preventDefault();
      this.back();
    }
  };

  private millions(id: string): string {
    const c = this.scenes?.[id]?.commuters;
    if (!c) return '';
    return c >= 1e6 ? `${(c / 1e6).toFixed(2)} million commuters` : `${Math.round(c / 1e3).toLocaleString('en-GB')},000 commuters`;
  }

  private items(): Item[] {
    if (this.screen === 'home') {
      const out: Item[] = [];
      if (this.actions.continueSummary) out.push({ id: 'continue', lbl: 'Continue', sub: this.actions.continueSummary });
      out.push(
        { id: 'new', lbl: 'New game', sub: 'Found a transit company with a government grant' },
        { id: 'sandbox', lbl: 'Sandbox', sub: 'Unlimited money, instant building' },
        { id: 'load', lbl: 'Load game', sub: 'Saved slots or a file' },
        { id: 'settings', lbl: 'Settings', sub: 'Units, light, detail' },
      );
      return out;
    }
    const name = CITIES[this.picked].name;
    return [
      ...MAPS.map((m) => ({ id: m.id, lbl: CITIES[m.id].name, sub: [m.mode, this.millions(m.id)].filter(Boolean).join(' · ') })),
      { id: 'go', lbl: this.sandbox ? `Start a sandbox in ${name}` : `Found a company in ${name}`, small: true, go: true },
      { id: 'back', lbl: 'Back', small: true },
    ];
  }

  /** Draw the menu; `animate` runs the stations' entrance (a new screen, not a pick within one). */
  private render(animate = true): void {
    const items = this.items();
    this.stops.classList.toggle('tt-anim', animate);
    this.sel = Math.min(this.sel, items.length - 1);
    this.kicker.textContent = this.screen === 'maps' ? (this.sandbox ? 'Sandbox · choose a map' : 'New game · choose a map') : '';
    this.stops.replaceChildren();
    items.forEach((it, i) => {
      const b = h(
        'button',
        {
          type: 'button',
          class: `tt-stop${it.small ? ' small' : ''}${it.go ? ' go' : ''}${this.screen === 'maps' && it.id === this.picked ? ' picked' : ''}`,
          onclick: (e: Event) => {
            e.stopPropagation();
            this.choose(it);
          },
        },
        h('span', { class: 'lbl' }, it.lbl),
        it.sub ? h('span', { class: 'sub' }, it.sub) : null,
      ) as HTMLButtonElement;
      const here = () => {
        if (this.sel === i) return;
        this.sel = i;
        this.mark();
      };
      b.addEventListener('mouseenter', here);
      b.addEventListener('focus', here);
      const li = h('li', { style: `--i:${i}` }, b);
      this.stops.append(li);
    });
    this.stops.append(h('div', { class: 'tt-train', 'aria-hidden': 'true' }));
    requestAnimationFrame(() => this.mark());
  }

  /** Light up the station you're on and send the train there. */
  private mark(): void {
    const stops = [...this.stops.querySelectorAll<HTMLButtonElement>('.tt-stop')];
    stops.forEach((b, i) => b.classList.toggle('here', i === this.sel));
    const b = stops[this.sel];
    const train = this.stops.querySelector<HTMLElement>('.tt-train');
    if (b && train) train.style.transform = `translateY(${b.parentElement!.offsetTop + 9}px)`;
  }

  private back(): void {
    this.screen = 'home';
    this.sel = this.actions.continueSummary ? (this.sandbox ? 2 : 1) : this.sandbox ? 1 : 0;
    this.render();
  }

  private choose(it: Item | undefined): void {
    if (!it) return;
    switch (it.id) {
      case 'continue':
        return this.actions.onContinue();
      case 'new':
      case 'sandbox':
        this.sandbox = it.id === 'sandbox';
        this.screen = 'maps';
        this.picked = (this.trailer?.city as CityId) ?? 'london';
        this.sel = MAPS.findIndex((m) => m.id === this.picked);
        return this.render();
      case 'load':
        return this.actions.onLoad();
      case 'settings':
        return this.actions.onSettings();
      case 'go':
        return this.actions.onNew(this.picked, this.sandbox);
      case 'back':
        return this.back();
      default:
        if (MAPS.some((m) => m.id === it.id)) {
          this.picked = it.id as CityId;
          if (this.trailer && this.trailer.city !== it.id) this.trailer.jumpTo(it.id);
          this.sel = MAPS.length;
          this.render(false);
        }
    }
  }

  // ------------------------------------------------------------------ now showing
  private tick = (): void => {
    if (this.destroyed || !this.trailer) return;
    this.raf = requestAnimationFrame(this.tick);
    const city = this.trailer.city;
    if (city !== this.lastCity) {
      this.lastCity = city;
      this.reel.replaceChildren(
        ...MAPS.map((m) =>
          h(
            'button',
            { type: 'button', class: m.id === city ? 'on' : '', onclick: (e: Event) => { e.stopPropagation(); this.trailer?.jumpTo(m.id); } },
            h('span', { class: 'bar' }, h('i')),
            h('span', null, CITIES[m.id].name),
          ),
        ),
      );
    }
    const i = MAPS.findIndex((m) => m.id === city);
    this.reel.querySelectorAll<HTMLElement>('.bar i').forEach((el, j) => (el.style.width = j < i ? '100%' : j === i ? `${this.trailer!.progress * 100}%` : '0'));
  };
}
