/**
 * Station sounds (WebAudio, all synthesised: no audio files). While a station is selected, or the
 * map is zoomed in close on one, you hear its platform: a crowd murmur that swells with the number
 * of people waiting, and a two-tone chime when a train pulls in. Per viewer: muted or not is
 * remembered (localStorage); the audio context starts on the first click (browser autoplay rules).
 */
import { TRAIN_STRIDE, type CompiledNetwork, type Snapshot } from '../sim/protocol';

const KEY = 'headway-sound';
const DWELLING = 2;

function loadOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export class StationAudio {
  on = loadOn();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private crowdLevel = 0;
  /** Compiled station index we're listening to (−1: none). */
  private focus = -1;
  /** Train ids dwelling at the focus station last snapshot. */
  private dwelling = new Set<number>();
  private lastChime = 0;
  onChange: () => void = () => {};

  constructor() {
    const start = () => {
      this.ensure();
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  toggle(): void {
    this.on = !this.on;
    try {
      localStorage.setItem(KEY, this.on ? 'on' : 'off');
    } catch {
      /* not remembered */
    }
    this.ensure();
    this.master?.gain.setTargetAtTime(this.on ? 1 : 0, this.ctx!.currentTime, 0.1);
    this.onChange();
  }

  private ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 1 : 0;
    this.master.connect(ctx.destination);
    // Crowd murmur: brown-ish noise through two voice-band filters, each wobbling slowly so it
    // sounds like many conversations rather than a hiss.
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04;
      data[i] = last * 3.2;
    }
    this.crowd = ctx.createGain();
    this.crowd.gain.value = 0;
    this.crowd.connect(this.master);
    for (const [freq, q, rate] of [
      [420, 1.4, 0.37],
      [900, 2.2, 0.61],
      [1600, 3, 0.83],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.35;
      lfo.connect(lfoGain).connect(g.gain);
      src.connect(bp).connect(g).connect(this.crowd);
      src.start(ctx.currentTime + Math.random());
      lfo.start();
    }
  }

  /** The station to listen to (compiled index), or −1. */
  setFocus(i: number): void {
    if (i === this.focus) return;
    this.focus = i;
    this.dwelling.clear();
  }

  /** Each snapshot: crowd level from the focus platform, chime for each train that just pulled in. */
  update(s: Snapshot, net: CompiledNetwork | null, paused: boolean): void {
    if (!this.ctx || !this.crowd) return;
    const now = this.ctx.currentTime;
    const waiting = this.focus >= 0 ? (s.waiting[this.focus] ?? 0) : 0;
    // Quiet platform ≈ 0.03; a few hundred people waiting ≈ full murmur.
    const target = paused || this.focus < 0 ? 0 : Math.min(0.32, 0.03 + 0.29 * (Math.log1p(waiting) / Math.log1p(600)));
    if (Math.abs(target - this.crowdLevel) > 0.005) {
      this.crowdLevel = target;
      this.crowd.gain.setTargetAtTime(target, now, 0.6);
    }
    if (this.focus < 0 || !net || paused) return;
    const nowDwelling = new Set<number>();
    for (let o = 0; o < s.trains.length; o += TRAIN_STRIDE) {
      if (s.trains[o + 7] !== DWELLING) continue;
      const r = net.routes[s.trains[o + 1]];
      const dir = r?.dirs[s.trains[o + 2] as 0 | 1];
      if (!dir || dir.stopStation[s.trains[o + 8]] !== this.focus) continue;
      nowDwelling.add(s.trains[o]);
    }
    let arrived = false;
    for (const id of nowDwelling) if (!this.dwelling.has(id)) arrived = true;
    this.dwelling = nowDwelling;
    if (arrived && now - this.lastChime > 1.2) {
      this.lastChime = now;
      this.chime(now);
    }
  }

  /** Two soft tones, high then low (a generic platform chime). */
  private chime(t: number): void {
    const ctx = this.ctx!;
    for (const [freq, at] of [
      [784, 0],
      [587, 0.32],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const over = ctx.createOscillator();
      over.type = 'sine';
      over.frequency.value = freq * 2.01;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(0.16, t + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0008, t + at + 1.4);
      const g2 = ctx.createGain();
      g2.gain.value = 0.18;
      osc.connect(g);
      over.connect(g2).connect(g);
      g.connect(this.master!);
      osc.start(t + at);
      over.start(t + at);
      osc.stop(t + at + 1.5);
      over.stop(t + at + 1.5);
    }
  }
}
