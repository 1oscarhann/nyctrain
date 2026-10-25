/**
 * Company logos: a badge shape, a symbol, two colours, a style and a wordmark font, all drawn as
 * SVG (100 × 100). Original shapes and symbols only. Pure: tests check every combination renders.
 */

export type ShapeId = 'circle' | 'roundSquare' | 'square' | 'shield' | 'hexagon' | 'diamond' | 'pill' | 'octagon' | 'pennant' | 'burst' | 'arch' | 'ticket';
export type SymbolId =
  | 'train'
  | 'tram'
  | 'arrow'
  | 'twoWay'
  | 'chevrons'
  | 'bolt'
  | 'star'
  | 'crown'
  | 'leaf'
  | 'wave'
  | 'mountain'
  | 'sun'
  | 'compass'
  | 'tracks'
  | 'network'
  | 'loop'
  | 'bridge'
  | 'tower'
  | 'anchor'
  | 'bird'
  | 'monogram';
export type LogoStyle = 'solid' | 'outline' | 'split' | 'ring';
export type FontId = 'grotesk' | 'humanist' | 'serif' | 'slab' | 'mono' | 'heavy' | 'rounded' | 'condensed';

export interface LogoSpec {
  shape: ShapeId;
  symbol: SymbolId;
  /** Badge colour. */
  base: string;
  /** Symbol / second colour. */
  accent: string;
  style: LogoStyle;
  font: FontId;
}

export const SHAPES: { id: ShapeId; name: string }[] = [
  { id: 'circle', name: 'Disc' },
  { id: 'roundSquare', name: 'Tile' },
  { id: 'square', name: 'Square' },
  { id: 'shield', name: 'Shield' },
  { id: 'hexagon', name: 'Hexagon' },
  { id: 'diamond', name: 'Diamond' },
  { id: 'pill', name: 'Lozenge' },
  { id: 'octagon', name: 'Octagon' },
  { id: 'pennant', name: 'Pennant' },
  { id: 'burst', name: 'Starburst' },
  { id: 'arch', name: 'Arch' },
  { id: 'ticket', name: 'Ticket' },
];

export const SYMBOLS: { id: SymbolId; name: string }[] = [
  { id: 'train', name: 'Train' },
  { id: 'tram', name: 'Tram' },
  { id: 'arrow', name: 'Arrow' },
  { id: 'twoWay', name: 'Both ways' },
  { id: 'chevrons', name: 'Chevrons' },
  { id: 'bolt', name: 'Bolt' },
  { id: 'star', name: 'Star' },
  { id: 'crown', name: 'Crown' },
  { id: 'leaf', name: 'Leaf' },
  { id: 'wave', name: 'Waves' },
  { id: 'mountain', name: 'Peaks' },
  { id: 'sun', name: 'Sun' },
  { id: 'compass', name: 'Compass' },
  { id: 'tracks', name: 'Rails' },
  { id: 'network', name: 'Network' },
  { id: 'loop', name: 'Loop' },
  { id: 'bridge', name: 'Bridge' },
  { id: 'tower', name: 'Clock tower' },
  { id: 'anchor', name: 'Anchor' },
  { id: 'bird', name: 'Swift' },
  { id: 'monogram', name: 'Initials' },
];

export const STYLES: { id: LogoStyle; name: string }[] = [
  { id: 'solid', name: 'Solid' },
  { id: 'outline', name: 'Outline' },
  { id: 'split', name: 'Two-tone' },
  { id: 'ring', name: 'Ringed' },
];

export const FONTS: { id: FontId; name: string; css: string; weight: number; spacing: string; upper: boolean }[] = [
  { id: 'grotesk', name: 'Grotesk', css: "Overpass, 'Helvetica Neue', Arial, sans-serif", weight: 800, spacing: '0.01em', upper: false },
  { id: 'humanist', name: 'Humanist', css: "Cabin, 'Gill Sans', 'Trebuchet MS', sans-serif", weight: 700, spacing: '0.02em', upper: false },
  { id: 'serif', name: 'Serif', css: "Georgia, 'Times New Roman', serif", weight: 700, spacing: '0.01em', upper: false },
  { id: 'slab', name: 'Slab', css: "Rockwell, 'Roboto Slab', 'Courier New', serif", weight: 700, spacing: '0.02em', upper: true },
  { id: 'mono', name: 'Mono', css: "'SFMono-Regular', Menlo, Consolas, monospace", weight: 700, spacing: '0', upper: true },
  { id: 'heavy', name: 'Heavy', css: "'Arial Black', Overpass, sans-serif", weight: 900, spacing: '-0.01em', upper: false },
  { id: 'rounded', name: 'Rounded', css: "'Varela Round', 'Arial Rounded MT Bold', Nunito, sans-serif", weight: 700, spacing: '0.02em', upper: false },
  { id: 'condensed', name: 'Condensed', css: "'Arial Narrow', 'Roboto Condensed', Overpass, sans-serif", weight: 700, spacing: '0.08em', upper: true },
];

export const LOGO_COLORS = [
  '#E1251B', '#F26B21', '#F5B700', '#8DC63F', '#00A651', '#00857C', '#00A3B0', '#0098D4', '#0A5CBF', '#1C3F94', '#5B2C83', '#9B0056',
  '#E05A9B', '#7A4A2A', '#C9A227', '#B7BDC5', '#4A4F57', '#111418', '#FFFFFF', '#F3E9D2',
];

export const DEFAULT_LOGO: LogoSpec = { shape: 'circle', symbol: 'train', base: '#0A5CBF', accent: '#FFFFFF', style: 'solid', font: 'grotesk' };

const SHAPE_PATH: Record<ShapeId, string> = {
  circle: 'M50 4 A46 46 0 1 1 49.99 4 Z',
  roundSquare: 'M26 5 H74 A21 21 0 0 1 95 26 V74 A21 21 0 0 1 74 95 H26 A21 21 0 0 1 5 74 V26 A21 21 0 0 1 26 5 Z',
  square: 'M8 8 H92 V92 H8 Z',
  shield: 'M50 4 L92 17 V47 C92 73 73 89 50 97 C27 89 8 73 8 47 V17 Z',
  hexagon: 'M50 3 L91 26.5 V73.5 L50 97 L9 73.5 V26.5 Z',
  diamond: 'M50 2 L98 50 L50 98 L2 50 Z',
  pill: 'M30 18 H70 A32 32 0 0 1 70 82 H30 A32 32 0 0 1 30 18 Z',
  octagon: 'M31 4 H69 L96 31 V69 L69 96 H31 L4 69 V31 Z',
  pennant: 'M50 4 L97 92 H3 Z',
  burst: burstPath(),
  arch: 'M8 96 V48 A42 42 0 0 1 92 48 V96 Z',
  ticket: 'M6 22 H94 V40 A10 10 0 0 0 94 60 V78 H6 V60 A10 10 0 0 0 6 40 Z',
};

/** Where a shape's visual centre sits, and how big a symbol it takes. */
const SHAPE_FIT: Partial<Record<ShapeId, { cy: number; scale: number }>> = {
  pennant: { cy: 64, scale: 0.62 },
  pill: { cy: 50, scale: 0.72 },
  ticket: { cy: 50, scale: 0.66 },
  diamond: { cy: 50, scale: 0.78 },
  arch: { cy: 58, scale: 0.86 },
  burst: { cy: 50, scale: 0.82 },
};

function burstPath(): string {
  const pts: string[] = [];
  const n = 16;
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? 41 : 48;
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(2)} ${(50 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
}

function starPoints(cx: number, cy: number, ro: number, ri: number, n = 5): string {
  const p: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    p.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return p.join(' ');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Up to three initials from a company name ("Thames Valley Rail" → "TVR"; skips "and", "of", "the"). */
export function initialsOf(name: string): string {
  const skip = new Set(['and', 'of', 'the', '&', 'co', 'ltd', 'inc', 'plc']);
  const words = name.split(/[\s-]+/).filter((w) => w && !skip.has(w.toLowerCase()));
  const s = words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 3);
  return s || 'H';
}

/** The symbol in 100 × 100 space, centred on (50, 50), in ink `c` with cut-outs in `bg`. */
function symbolSvg(id: SymbolId, c: string, bg: string, name: string, font: FontId): string {
  const st = (w: number) => `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (id) {
    case 'train':
      return `<path d="M34 22 H66 A9 9 0 0 1 75 31 V64 A8 8 0 0 1 67 72 H33 A8 8 0 0 1 25 64 V31 A9 9 0 0 1 34 22 Z" fill="${c}"/><rect x="32" y="30" width="36" height="17" rx="3" fill="${bg}"/><circle cx="35" cy="60" r="4" fill="${bg}"/><circle cx="65" cy="60" r="4" fill="${bg}"/><path d="M35 72 L28 82 M65 72 L72 82" ${st(5)}/>`;
    case 'tram':
      return `<path d="M40 14 L50 22 L60 14" ${st(4)}/><path d="M50 22 V27" ${st(4)}/><rect x="28" y="27" width="44" height="46" rx="10" fill="${c}"/><rect x="34" y="34" width="32" height="14" rx="3" fill="${bg}"/><circle cx="38" cy="63" r="3.5" fill="${bg}"/><circle cx="62" cy="63" r="3.5" fill="${bg}"/><path d="M24 82 H76" ${st(5)}/>`;
    case 'arrow':
      return `<path d="M22 50 H74 M56 32 L76 50 L56 68" ${st(11)}/>`;
    case 'twoWay':
      return `<path d="M24 38 H72 M60 26 L74 38 L60 50" ${st(8)}/><path d="M76 62 H28 M40 50 L26 62 L40 74" ${st(8)}/>`;
    case 'chevrons':
      return `<path d="M24 28 L44 50 L24 72 M48 28 L68 50 L48 72" ${st(10)}/>`;
    case 'bolt':
      return `<path d="M57 14 L27 56 H48 L41 86 L73 42 H52 Z" fill="${c}"/>`;
    case 'star':
      return `<polygon points="${starPoints(50, 52, 34, 14)}" fill="${c}"/>`;
    case 'crown':
      return `<path d="M22 70 L26 32 L40 50 L50 26 L60 50 L74 32 L78 70 Z" fill="${c}"/><rect x="22" y="74" width="56" height="7" rx="2" fill="${c}"/>`;
    case 'leaf':
      return `<path d="M26 74 C26 42 46 24 76 24 C76 56 60 76 26 74 Z" fill="${c}"/><path d="M30 70 L62 38" stroke="${bg}" stroke-width="4" stroke-linecap="round"/>`;
    case 'wave':
      return `<path d="M20 38 Q30 28 40 38 T60 38 T80 38" ${st(7)}/><path d="M20 54 Q30 44 40 54 T60 54 T80 54" ${st(7)}/><path d="M20 70 Q30 60 40 70 T60 70 T80 70" ${st(7)}/>`;
    case 'mountain':
      return `<path d="M14 76 L40 34 L52 52 L62 40 L86 76 Z" fill="${c}"/><path d="M40 34 L33 45 L40 42 L46 46 Z" fill="${bg}"/>`;
    case 'sun':
      return `<circle cx="50" cy="50" r="15" fill="${c}"/>${Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return `<path d="M${(50 + 22 * Math.cos(a)).toFixed(1)} ${(50 + 22 * Math.sin(a)).toFixed(1)} L${(50 + 32 * Math.cos(a)).toFixed(1)} ${(50 + 32 * Math.sin(a)).toFixed(1)}" ${st(6)}/>`; }).join('')}`;
    case 'compass':
      return `<circle cx="50" cy="50" r="30" ${st(5)}/><path d="M50 22 L58 50 L50 78 L42 50 Z" fill="${c}"/><circle cx="50" cy="50" r="4" fill="${bg}"/>`;
    case 'tracks':
      return `<path d="M40 16 L30 84 M60 16 L70 84" ${st(5)}/>${[24, 38, 52, 66, 80].map((y) => { const w = 12 + (y - 16) * 0.22; return `<path d="M${50 - w} ${y} H${50 + w}" ${st(4)}/>`; }).join('')}`;
    case 'network':
      return `<path d="M20 66 L40 38 L60 60 L80 32" ${st(6)}/><circle cx="20" cy="66" r="8" fill="${c}"/><circle cx="40" cy="38" r="8" fill="${c}"/><circle cx="60" cy="60" r="8" fill="${c}"/><circle cx="80" cy="32" r="8" fill="${c}"/><circle cx="40" cy="38" r="3.5" fill="${bg}"/><circle cx="60" cy="60" r="3.5" fill="${bg}"/>`;
    case 'loop':
      return `<path d="M72 40 A24 24 0 1 0 74 58" ${st(9)}/><path d="M62 30 L74 40 L84 28" ${st(7)}/>`;
    case 'bridge':
      return `<path d="M14 64 H86" ${st(6)}/><path d="M18 64 Q50 18 82 64" ${st(6)}/>${[30, 40, 50, 60, 70].map((x) => { const y = 64 - (1 - ((x - 50) / 32) ** 2) * 28; return `<path d="M${x} ${y.toFixed(1)} V64" ${st(3)}/>`; }).join('')}<path d="M22 64 V78 M78 64 V78" ${st(6)}/>`;
    case 'tower':
      return `<path d="M50 12 L60 26 H40 Z" fill="${c}"/><rect x="38" y="26" width="24" height="56" fill="${c}"/><circle cx="50" cy="40" r="8" fill="${bg}"/><path d="M50 35 V40 L53 42" stroke="${c}" stroke-width="2" stroke-linecap="round" fill="none"/><rect x="45" y="60" width="10" height="22" rx="5" fill="${bg}"/>`;
    case 'anchor':
      return `<circle cx="50" cy="22" r="7" ${st(5)}/><path d="M50 29 V80 M36 40 H64" ${st(6)}/><path d="M24 58 Q28 80 50 80 Q72 80 76 58" ${st(6)}/>`;
    case 'bird':
      return `<path d="M14 52 Q34 40 50 50 Q62 30 88 26 Q72 40 66 52 Q56 68 34 66 L48 58 Q30 60 14 52 Z" fill="${c}"/>`;
    case 'monogram': {
      const t = initialsOf(name);
      const f = FONTS.find((x) => x.id === font) ?? FONTS[0];
      const size = t.length === 1 ? 56 : t.length === 2 ? 42 : 31;
      return `<text x="50" y="52" text-anchor="middle" dominant-baseline="central" font-family="${esc(f.css)}" font-weight="${f.weight}" font-size="${size}" fill="${c}" letter-spacing="${t.length > 2 ? -1 : 0}">${esc(t)}</text>`;
    }
  }
}

/** The logo as an SVG string (size in px; the name gives the monogram its initials). */
export function logoSvg(spec: LogoSpec, size = 48, name = 'Headway'): string {
  const shape = SHAPE_PATH[spec.shape] ?? SHAPE_PATH.circle;
  const fit = SHAPE_FIT[spec.shape] ?? { cy: 50, scale: 0.9 };
  const id = `lg${Math.random().toString(36).slice(2, 8)}`;
  let badge = '';
  let ink = spec.accent;
  let cut = spec.base;
  switch (spec.style) {
    case 'solid':
      badge = `<path d="${shape}" fill="${spec.base}"/>`;
      break;
    case 'outline':
      badge = `<path d="${shape}" fill="none" stroke="${spec.base}" stroke-width="7" transform="translate(50 50) scale(0.93) translate(-50 -50)"/>`;
      ink = spec.base;
      cut = 'transparent';
      break;
    case 'split':
      badge = `<clipPath id="${id}"><path d="${shape}"/></clipPath><g clip-path="url(#${id})"><rect x="0" y="0" width="100" height="100" fill="${spec.base}"/><path d="M0 100 L100 0 L100 100 Z" fill="${spec.accent}"/></g>`;
      ink = '#FFFFFF';
      cut = spec.base;
      if (isLight(spec.base) && isLight(spec.accent)) ink = '#111418';
      break;
    case 'ring':
      badge = `<path d="${shape}" fill="${spec.base}"/><path d="${shape}" fill="none" stroke="${spec.accent}" stroke-width="5" transform="translate(50 50) scale(0.82) translate(-50 -50)"/>`;
      break;
  }
  if (spec.style !== 'outline' && spec.style !== 'split' && sameish(ink, spec.base)) ink = isLight(spec.base) ? '#111418' : '#FFFFFF';
  const sym = symbolSvg(spec.symbol, ink, cut === 'transparent' ? 'none' : cut, name, spec.font);
  const s = spec.style === 'ring' ? fit.scale * 0.8 : fit.scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${esc(name)} logo">${badge}<g transform="translate(50 ${fit.cy}) scale(${s.toFixed(3)}) translate(-50 -50)">${sym}</g></svg>`;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return [n >> 16, (n >> 8) & 255, n & 255];
}
export function isLight(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}
function sameish(a: string, b: string): boolean {
  const x = rgb(a), y = rgb(b);
  return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 60;
}

/** A random, good-looking combination (contrasting colours). */
export function randomLogo(rand: () => number = Math.random): LogoSpec {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  const base = pick(LOGO_COLORS.filter((c) => !isLight(c)));
  let accent = pick(LOGO_COLORS);
  for (let i = 0; i < 10 && sameish(accent, base); i++) accent = pick(LOGO_COLORS);
  return { shape: pick(SHAPES).id, symbol: pick(SYMBOLS).id, base, accent: rand() < 0.55 ? '#FFFFFF' : accent, style: pick(STYLES).id, font: pick(FONTS).id };
}

/** A logo from a save (anything unknown falls back to the default, field by field). */
export function sanitizeLogo(raw: unknown): LogoSpec {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
  const oneOf = <T extends string>(v: unknown, all: { id: T }[], d: T): T => (all.some((x) => x.id === v) ? (v as T) : d);
  return {
    shape: oneOf(o.shape, SHAPES, DEFAULT_LOGO.shape),
    symbol: oneOf(o.symbol, SYMBOLS, DEFAULT_LOGO.symbol),
    base: hex(o.base, DEFAULT_LOGO.base),
    accent: hex(o.accent, DEFAULT_LOGO.accent),
    style: oneOf(o.style, STYLES, DEFAULT_LOGO.style),
    font: oneOf(o.font, FONTS, DEFAULT_LOGO.font),
  };
}

/** Company name ideas for the 🎲 button, by city. */
export function suggestName(cityName: string, rand: () => number = Math.random): string {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  const lead = [cityName, cityName, 'Metro', 'Swift', 'Union', 'Crosstown', 'Northern & Southern', 'Capital', 'Greater', 'Riverside', 'Harbour', 'Pioneer', 'Evergreen', 'Silverline', 'Meridian', 'Keystone'];
  const tail = ['Rapid Transit', 'Railways', 'Metro Company', 'Transit Co.', 'Rail Group', 'Underground Co.', 'Lines', 'Railway Company', 'Transit Authority', 'Connect', 'Rail & Light'];
  let a = pick(lead);
  if (a === cityName && rand() < 0.3) a = `${cityName} & District`;
  return `${a} ${pick(tail)}`;
}
