/** Tiny DOM helpers — the UI is plain TypeScript, no framework. */
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function svgIcon(path: string, viewBox = '0 0 24 24'): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return wrap.firstChild as SVGSVGElement;
}

/**
 * Route bullet: circle in the route colour with a bold white letter or number. Express routes
 * (v2, docs/v2/express-quad.md §2.4) get the express lozenge: an elongated hexagon 1.32× as wide
 * as it is tall with pointed ends and a white keyline (an outer white hexagon holding the coloured
 * one), deliberately not a diamond.
 */
export function bullet(color: string, text: string, size = 22, express = false): HTMLElement {
  const fontSize = Math.round(size * (text.length > 1 ? 0.48 : 0.6)) + 'px';
  // London style: a line bar (a rounded rectangle in the line colour) instead of a disc; express
  // services keep the lozenge so they still read as different at a glance.
  if (!express && document.documentElement.dataset.theme === 'tfl') {
    return h(
      'span',
      { class: 'bullet bar', style: { background: color, width: Math.round(size * 1.55) + 'px', height: Math.round(size * 0.78) + 'px', fontSize: Math.round(size * 0.5) + 'px', color: barInk(color) } },
      text,
    );
  }
  if (express) {
    return h(
      'span',
      { class: 'bullet express', title: 'Express', style: { width: Math.round(size * 1.32) + 'px', height: size + 'px', fontSize } },
      h('span', { style: `--c:${color}` }, text),
    );
  }
  return h(
    'span',
    {
      class: 'bullet',
      style: {
        background: color,
        width: size + 'px',
        height: size + 'px',
        fontSize,
      },
    },
    text,
  );
}

/** Text colour on a line bar: navy on light colours (yellow, pink, aqua), white on the rest. */
function barInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.68 ? '#111' : '#fff';
}
