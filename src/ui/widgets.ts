/** Small shared UI pieces: tooltip, toasts, modal dialogs, busy indicator, overlay legend. */
import { h } from './dom';
import { rampCss } from '../map/colorRamp';
import type { OverlayLegend } from '../map/overlays';

export class Tooltip {
  readonly el = h('div', { class: 'hw-tip', style: 'display:none' });
  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }
  show(html: string | null, px?: [number, number]): void {
    if (!html) {
      this.el.style.display = 'none';
      return;
    }
    this.el.innerHTML = html;
    this.el.style.display = 'block';
    if (px) {
      const pad = 16;
      const w = this.el.offsetWidth;
      const hgt = this.el.offsetHeight;
      let x = px[0] + pad;
      let y = px[1] + pad;
      if (x + w > window.innerWidth - 8) x = px[0] - w - pad;
      if (y + hgt > window.innerHeight - 8) y = px[1] - hgt - pad;
      this.el.style.left = `${Math.max(4, x)}px`;
      this.el.style.top = `${Math.max(4, y)}px`;
    }
  }
}

/** Hover tooltips for buttons (title + shortcut). */
export function attachTip(el: HTMLElement, tip: Tooltip, title: string, key?: string, body?: string): void {
  el.addEventListener('mouseenter', () => {
    const r = el.getBoundingClientRect();
    tip.show(
      `<div class="title">${title}${key ? `<span class="kbd">${key}</span>` : ''}</div>${body ? `<div class="hw-muted">${body}</div>` : ''}`,
      [r.right - 8, r.top - 6],
    );
  });
  el.addEventListener('mouseleave', () => tip.show(null));
  el.addEventListener('mousedown', () => tip.show(null));
}

export class Toasts {
  readonly el = h('div', { id: 'toasts' });
  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }
  show(title: string, body?: string, tone: 'green' | 'amber' | 'red' = 'green', ms = 4200): void {
    const t = h('div', { class: `toast hw-panel ${tone}` }, h('div', { class: 't' }, title), body ? h('div', { class: 'b' }, body) : null);
    this.el.prepend(t);
    while (this.el.children.length > 5) this.el.lastChild?.remove();
    setTimeout(() => {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 320);
    }, ms);
    t.addEventListener('click', () => t.remove());
  }
}

export function modal(root: HTMLElement, content: HTMLElement, opts: { onClose?: () => void; dismissable?: boolean } = {}): () => void {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal hw-panel' }, content);
  back.append(box);
  root.append(back);
  const close = () => {
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && opts.dismissable !== false) {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  if (opts.dismissable !== false) back.addEventListener('mousedown', (e) => e.target === back && close());
  return close;
}

export function confirmDialog(root: HTMLElement, title: string, body: string, ok: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const okBtn = h('button', { class: `hw-btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, ok);
    const content = h(
      'div',
      null,
      h('h2', null, title),
      h('div', { class: 'hw-muted', style: 'line-height:1.5' }, body),
      h('div', { class: 'actions' }, h('button', { class: 'hw-btn', onclick: () => finish(false) }, 'Cancel'), okBtn),
    );
    const close = modal(root, content, { onClose: () => finish(false) });
    setTimeout(() => okBtn.focus(), 0);
  });
}

export class Busy {
  readonly el = h('div', { id: 'busy', class: 'hw-panel' }, h('div', { class: 'spinner' }), h('span', null, ''));
  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }
  set(label: string | null): void {
    this.el.className = 'hw-panel' + (label ? ' open' : '');
    (this.el.lastChild as HTMLElement).textContent = label ?? '';
  }
}

export class Legend {
  readonly el = h('div', { id: 'legend', class: 'hw-panel' });
  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }
  set(l: OverlayLegend | null): void {
    this.el.className = 'hw-panel' + (l ? ' open' : '');
    this.el.replaceChildren();
    if (!l) return;
    this.el.append(
      h('div', { style: 'font-weight:700' }, l.title),
      h('div', { class: 'bar', style: { background: rampCss(l.ramp) } }),
      h('div', { class: 'ends' }, h('span', null, l.lo), h('span', null, l.hi)),
    );
    if (l.note) this.el.append(h('div', { class: 'hw-muted', style: 'font-size:11.5px;margin-top:4px' }, l.note));
  }
}
