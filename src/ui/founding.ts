/**
 * Found your company (new game) or rebrand it (in game): name, a logo built from shapes, symbols,
 * colours, styles and lettering (ui/logo.ts), and, for a new career, the government start-up grant
 * and how chaotic the city is.
 */
import { CHAOS, type ChaosLevel } from '../balance';
import { city } from '../cities';
import { GRANTS, grantAmount, type Company, type GrantKind } from '../core/company';
import { fmtMoney } from '../core/units';
import { h } from './dom';
import { DEFAULT_LOGO, FONTS, LOGO_COLORS, logoSvg, randomLogo, SHAPES, STYLES, suggestName, SYMBOLS, type LogoSpec } from './logo';
import { modal } from './widgets';

const html = (svg: string) => {
  const s = h('span', { class: 'logo-svg' });
  s.innerHTML = svg;
  return s;
};

/** Company name in its lettering. */
export function wordmark(c: { name: string; logo: LogoSpec }, size = 15): HTMLElement {
  const f = FONTS.find((x) => x.id === c.logo.font) ?? FONTS[0];
  return h('span', { class: 'wordmark', style: { fontFamily: f.css, fontWeight: String(f.weight), letterSpacing: f.spacing, textTransform: f.upper ? 'uppercase' : 'none', fontSize: `${size}px` } }, c.name);
}

/** Logo and name side by side (top bar, finances, reports). */
export function brandMark(c: { name: string; logo: LogoSpec }, size = 26, text = 15): HTMLElement {
  return h('span', { class: 'brand-mark' }, html(logoSvg(c.logo, size, c.name)), wordmark(c, text));
}

type Tab = 'symbol' | 'shape' | 'colours' | 'style';

export interface FoundingResult {
  company: Omit<Company, 'founded'>;
  chaos: ChaosLevel;
  tutorial: boolean;
}

/**
 * Show the founding screen. `edit` rebrands an existing company (no grant or chaos choice).
 * Resolves with the choices, or null if cancelled.
 */
export function foundCompany(
  root: HTMLElement,
  opts: { sandbox: boolean; edit?: Company; chaos?: ChaosLevel; levelLabels?: Record<ChaosLevel, string>; levelHints?: Record<ChaosLevel, string> },
): Promise<FoundingResult | null> {
  return new Promise((resolve) => {
    const c = city();
    let name = opts.edit?.name ?? suggestName(c.name);
    let logo: LogoSpec = opts.edit ? { ...opts.edit.logo } : randomLogo();
    let grant: GrantKind = opts.edit?.grantKind ?? 'standard';
    let chaos: ChaosLevel = opts.chaos ?? CHAOS.defaultLevel;
    let tutorial = false;
    let tab: Tab = 'symbol';
    let done = false;

    const preview = h('div', { class: 'found-preview' });
    const nameInput = h('input', { type: 'text', class: 'found-name', maxlength: '40', value: name, 'aria-label': 'Company name' }) as HTMLInputElement;
    nameInput.addEventListener('input', () => {
      name = nameInput.value;
      renderPreview();
      if (logo.symbol === 'monogram' || tab === 'style') renderTab();
      renderActions();
    });
    const dice = h('button', { class: 'hw-btn', title: 'Suggest a name', onclick: () => { name = suggestName(c.name); nameInput.value = name; renderPreview(); renderTab(); renderActions(); } }, '🎲');
    const tabs = h('div', { class: 'seg found-tabs' });
    const tabBody = h('div', { class: 'found-tab' });
    const extras = h('div');
    const actions = h('div', { class: 'actions' });

    const renderPreview = () => {
      preview.replaceChildren(
        html(logoSvg(logo, 140, name || 'Company')),
        h('div', { class: 'found-word' }, wordmark({ name: name || 'Your company', logo }, 22)),
        h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:4px' }, `${opts.edit ? 'Rebrand' : 'Founded'} · ${c.name}`),
        h('div', { class: 'found-small' }, html(logoSvg(logo, 28, name)), html(logoSvg(logo, 20, name)), h('span', { class: 'hw-muted', style: 'font-size:11px' }, 'small sizes')),
      );
    };

    const option = (spec: LogoSpec, on: boolean, label: string, pick: () => void, size = 48) =>
      h('button', { class: `logo-opt${on ? ' on' : ''}`, title: label, onclick: () => { pick(); renderPreview(); renderTab(); } }, html(logoSvg(spec, size, name)), h('span', null, label));

    const renderTab = () => {
      tabs.replaceChildren(
        ...(['symbol', 'shape', 'colours', 'style'] as Tab[]).map((t) =>
          h('button', { class: t === tab ? 'on' : '', onclick: () => { tab = t; renderTab(); } }, { symbol: 'Symbol', shape: 'Badge shape', colours: 'Colours', style: 'Style & lettering' }[t]),
        ),
      );
      const grid = h('div', { class: 'logo-grid' });
      if (tab === 'symbol') for (const s of SYMBOLS) grid.append(option({ ...logo, symbol: s.id }, logo.symbol === s.id, s.name, () => (logo.symbol = s.id)));
      if (tab === 'shape') for (const s of SHAPES) grid.append(option({ ...logo, shape: s.id }, logo.shape === s.id, s.name, () => (logo.shape = s.id)));
      if (tab === 'colours') {
        const sw = (cur: string, set: (v: string) => void) =>
          h('div', { class: 'swatches' }, ...LOGO_COLORS.map((col) => h('button', { class: `swatch${col.toLowerCase() === cur.toLowerCase() ? ' on' : ''}`, style: { background: col }, title: col, onclick: () => { set(col); renderPreview(); renderTab(); } })));
        const custom = (cur: string, set: (v: string) => void) => {
          const i = h('input', { type: 'color', class: 'color-custom', value: cur, title: 'Any colour' }) as HTMLInputElement;
          i.addEventListener('input', () => { set(i.value.toUpperCase()); renderPreview(); });
          i.addEventListener('change', () => renderTab());
          return i;
        };
        tabBody.replaceChildren(
          h('div', { class: 'found-label' }, 'Badge colour'),
          h('div', { class: 'sw-row' }, sw(logo.base, (v) => (logo.base = v)), custom(logo.base, (v) => (logo.base = v))),
          h('div', { class: 'found-label' }, 'Symbol / second colour'),
          h('div', { class: 'sw-row' }, sw(logo.accent, (v) => (logo.accent = v)), custom(logo.accent, (v) => (logo.accent = v))),
          h('button', { class: 'hw-btn small', style: 'margin-top:10px', onclick: () => { [logo.base, logo.accent] = [logo.accent, logo.base]; renderPreview(); renderTab(); } }, 'Swap colours'),
        );
        return;
      }
      if (tab === 'style') {
        const styles = h('div', { class: 'logo-grid' }, ...STYLES.map((s) => option({ ...logo, style: s.id }, logo.style === s.id, s.name, () => (logo.style = s.id))));
        const fonts = h('div', { class: 'font-grid' }, ...FONTS.map((f) => h('button', { class: `font-opt${logo.font === f.id ? ' on' : ''}`, onclick: () => { logo.font = f.id; renderPreview(); renderTab(); } }, wordmark({ name: name || 'Company', logo: { ...logo, font: f.id } }, 15), h('span', null, f.name))));
        tabBody.replaceChildren(h('div', { class: 'found-label' }, 'Style'), styles, h('div', { class: 'found-label' }, 'Lettering'), fonts);
        return;
      }
      tabBody.replaceChildren(grid);
    };

    const renderExtras = () => {
      if (opts.edit) return extras.replaceChildren();
      const parts: HTMLElement[] = [];
      if (!opts.sandbox) {
        parts.push(
          h('div', { class: 'found-label' }, 'Government start-up grant'),
          h('div', { class: 'hw-muted', style: 'font-size:12.5px;margin-bottom:8px' }, `The government is backing a new ${c.transitWord} company for ${c.name}. The grant is your starting money; after that it's fares, value capture and bonds.`),
          h('div', { class: 'grant-row' }, ...GRANTS.map((g) => h('button', { class: `grant-opt${grant === g.id ? ' on' : ''}`, onclick: () => { grant = g.id; renderExtras(); } }, h('b', null, fmtMoney(grantAmount(g.id))), h('span', { class: 'g-name' }, g.name), h('span', { class: 'hw-muted' }, g.blurb)))),
        );
      }
      const lvl = h('div', { class: 'seg' }, ...CHAOS.levels.map((l) => h('button', { class: l === chaos ? 'on' : '', onclick: () => { chaos = l; renderExtras(); } }, opts.levelLabels?.[l] ?? l)));
      parts.push(
        h('div', { class: 'found-label' }, 'City chaos: events, disruptions and weather'),
        lvl,
        h('div', { class: 'hw-muted', style: 'font-size:12px;margin-top:4px' }, `${opts.levelHints?.[chaos] ?? ''}. Change it any time.`),
        h('label', { class: 'found-check' }, (() => { const cb = h('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = tutorial; cb.addEventListener('change', () => (tutorial = cb.checked)); return cb; })(), ' Start with the tutorial (eight short steps)'),
      );
      extras.replaceChildren(...parts);
    };

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      close();
      if (!ok) return resolve(null);
      const nm = name.trim() || suggestName(c.name);
      resolve({ company: { name: nm.slice(0, 40), logo: { ...logo }, grantKind: grant, grant: opts.sandbox ? 0 : grantAmount(grant) }, chaos, tutorial });
    };
    const renderActions = () => {
      actions.replaceChildren(
        h('button', { class: 'hw-btn ghost', onclick: () => { logo = randomLogo(); renderPreview(); renderTab(); } }, 'Surprise me'),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'hw-btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'hw-btn primary', disabled: !name.trim(), onclick: () => finish(true) }, opts.edit ? 'Save brand' : opts.sandbox ? 'Start sandbox' : 'Found the company'),
      );
    };

    renderPreview();
    renderTab();
    renderExtras();
    renderActions();
    const body = h(
        'div',
        { class: 'found' },
        h('h2', null, opts.edit ? 'Your company' : 'Found your company'),
        h(
          'div',
          { class: 'found-cols' },
          h('div', { class: 'found-left' }, preview, h('div', { class: 'found-label' }, 'Company name'), h('div', { style: 'display:flex;gap:6px' }, nameInput, dice)),
          h('div', { class: 'found-right' }, tabs, tabBody),
        ),
        extras,
        actions,
      );
    const close = modal(root, body, { onClose: () => finish(false) });
    body.closest('.modal')?.classList.add('found-modal');
    setTimeout(() => nameInput.select(), 50);
  });
}

export { DEFAULT_LOGO };
