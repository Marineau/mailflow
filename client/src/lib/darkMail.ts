/**
 * Dark rendering for HTML mail, in the spirit of Outlook's reading pane.
 *
 * A CSS `invert()` filter would also flip photographs and turn brand colors
 * into their complements. Instead each declared color is remapped by role:
 * light page backgrounds fall to black, dark text rises toward white, and
 * saturated colors keep their hue so buttons, links and warnings stay
 * recognizable. The curves are fixed points — a color this function emits is
 * left alone if it is seen again — so a message that was already designed
 * for a dark background is not inverted a second time.
 *
 * `@media (prefers-color-scheme: dark)` blocks are copied through. When the
 * system is dark those rules override the rewritten light palette; when it
 * is not, the rewritten palette is what shows.
 */

import { plateVerdict } from './mailPlates';

type MailColorRole = 'text' | 'background' | 'border' | 'shadow' | 'ambiguous';

interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NOT_A_COLOR = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'none',
  'auto',
]);

/** Names emails actually use. Anything else is resolved by the canvas, in the browser. */
const BASIC: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  navy: '#000080',
  teal: '#008080',
  aqua: '#00ffff',
  fuchsia: '#ff00ff',
  lime: '#00ff00',
  olive: '#808000',
  whitesmoke: '#f5f5f5',
  gainsboro: '#dcdcdc',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  dimgray: '#696969',
  dimgrey: '#696969',
  lightblue: '#add8e6',
  lightgreen: '#90ee90',
  lightyellow: '#ffffe0',
  pink: '#ffc0cb',
  gold: '#ffd700',
  brown: '#a52a2a',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  rebeccapurple: '#663399',
};

const colorCache = new Map<string, RGB | null>();
/** Couleurs distinctes vues dans les mails. Au-delà, les plus anciennes sortent. */
const COLOR_CACHE_MAX = 2048;

const COLOR_RE =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|rgba?\([^)]*\)|hsla?\([^)]*\)|(?:oklch|oklab|lab|lch|hwb|color)\([^)]*\)|(?<![\w-])[a-zA-Z]+(?![\w-])/g;

const DECL_RE = /(^|[{};\s])(-{0,2}[A-Za-z_][\w-]*)\s*:\s*([^;{}]+)/g;

/** Chroma above this is a brand color (a button, a link), not a tinted gray. */
const VIVID = 0.28;

let holderSeq = 0;

function makeHolder(): { hold: (chunk: string) => string; restore: (text: string) => string } {
  const id = holderSeq++;
  const holds: string[] = [];
  const re = new RegExp(`\u0001${id}:(\\d+)\u0001`, 'g');
  return {
    hold(chunk: string) {
      const index = holds.length;
      holds.push(chunk);
      return `\u0001${id}:${index}\u0001`;
    },
    restore(text: string) {
      // A url() hold can contain a string hold. Replace until nothing is left.
      let out = text;
      for (let n = 0; n < 8; n++) {
        re.lastIndex = 0;
        const next = out.replace(re, (_match, index: string) => holds[Number(index)] ?? '');
        if (next === out) return out;
        out = next;
      }
      return out;
    },
  };
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relLuminance(c: RGB): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function chroma(c: RGB): number {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function byte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function sameColor(a: RGB, b: RGB): boolean {
  return (
    Math.abs(a.r - b.r) < 1.2 &&
    Math.abs(a.g - b.g) < 1.2 &&
    Math.abs(a.b - b.b) < 1.2 &&
    Math.abs(a.a - b.a) < 0.01
  );
}

/** Mix toward black or white until `target` relative luminance, keeping the hue. */
function setLuminance(c: RGB, target: number): RGB {
  const current = relLuminance(c);
  if (Math.abs(current - target) < 0.004) return c;
  // A white page should land on black, not on a leftover #040404.
  if (target <= 0.004 && current > target) return { r: 0, g: 0, b: 0, a: c.a };

  const towardWhite = target > current;
  let lo = 0;
  let hi = 1;
  let best = c;

  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    const mixed: RGB = towardWhite
      ? {
          r: c.r + (255 - c.r) * t,
          g: c.g + (255 - c.g) * t,
          b: c.b + (255 - c.b) * t,
          a: c.a,
        }
      : { r: c.r * (1 - t), g: c.g * (1 - t), b: c.b * (1 - t), a: c.a };
    best = mixed;
    const L = relLuminance(mixed);
    if (Math.abs(L - target) < 0.002) break;
    // Mixing toward white, luminance rises with t. Toward black, it falls.
    const tooDark = L < target;
    if (towardWhite ? tooDark : !tooDark) lo = t;
    else hi = t;
  }

  return best;
}

function mapBackground(c: RGB): RGB {
  const L = relLuminance(c);
  if (chroma(c) >= VIVID) {
    // A mid blue or red button is already readable on black. A yellow or lime
    // fill is not: the text on it is about to turn white, so the fill has to
    // drop far enough for that white to clear roughly 4.5:1.
    if (L <= 0.32) return c;
    const target = Math.min(0.16, Math.max(0.12, L * 0.22));
    return target < L - 0.02 ? setLuminance(c, target) : c;
  }
  // Neutral surfaces. White lands on black; a slightly off-white card stays
  // one step lighter so sections still separate. Results sit at or below the
  // keep-threshold, so a second pass does not darken them again.
  const keep = 0.08;
  if (L <= keep) return c;
  const t = (L - keep) / (1 - keep);
  const target = keep * (1 - t) ** 0.55;
  return target < L - 0.004 ? setLuminance(c, target) : c;
}

function mapText(c: RGB): RGB {
  const L = relLuminance(c);
  if (chroma(c) >= VIVID) {
    if (L >= 0.62) return c;
    const target = Math.min(0.78, Math.max(0.62, 0.7 - L * 0.15));
    return target > L + 0.02 ? setLuminance(c, target) : c;
  }
  const keep = 0.62;
  if (L >= keep) return c;
  const t = L / keep;
  // Black becomes near-white. A mid gray stays dimmer, so a caption does not
  // turn into a second headline. Targets land above `keep`.
  const target = 0.96 - Math.sqrt(t) * 0.42;
  return target > L + 0.01 ? setLuminance(c, target) : c;
}

function mapBorder(c: RGB): RGB {
  const L = relLuminance(c);
  if (chroma(c) >= VIVID) {
    if (L >= 0.38 && L <= 0.72) return c;
    const target = L < 0.38 ? 0.48 : 0.58;
    return Math.abs(target - L) > 0.02 ? setLuminance(c, target) : c;
  }
  // A hairline that was #eee on white, or #222 on white, both disappear on
  // black. Park every neutral rule on the same quiet gray.
  if (L >= 0.045 && L <= 0.11) return c;
  return setLuminance(c, 0.07);
}

function mapShadow(c: RGB): RGB {
  const L = relLuminance(c);
  if (L <= 0.2) return c;
  return setLuminance(c, Math.min(L, 0.04));
}

function mapByRole(c: RGB, role: MailColorRole): RGB {
  if (role === 'ambiguous') return relLuminance(c) >= 0.55 ? mapBackground(c) : mapText(c);
  if (role === 'background') return mapBackground(c);
  if (role === 'border') return mapBorder(c);
  if (role === 'shadow') return mapShadow(c);
  return mapText(c);
}

function formatColor(c: RGB): string {
  const r = byte(c.r);
  const g = byte(c.g);
  const b = byte(c.b);
  if (c.a < 0.999) {
    const a = Math.round(c.a * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(hex: string): RGB | null {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  if (h.length === 6) {
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  return { r: (n >> 24) & 255, g: (n >> 16) & 255, b: (n >> 8) & 255, a: (n & 255) / 255 };
}

function parseChannel(v: string): number | null {
  if (v.endsWith('%')) {
    const n = Number(v.slice(0, -1));
    if (Number.isNaN(n)) return null;
    return Math.min(255, Math.max(0, (n / 100) * 255));
  }
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.min(255, Math.max(0, n));
}

function parseAlpha(v: string): number | null {
  if (v.endsWith('%')) {
    const n = Number(v.slice(0, -1));
    if (Number.isNaN(n)) return null;
    return Math.min(1, Math.max(0, n / 100));
  }
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function parseHue(v: string): number | null {
  if (v.endsWith('turn')) {
    const n = Number(v.slice(0, -4));
    return Number.isNaN(n) ? null : n * 360;
  }
  if (v.endsWith('rad')) {
    const n = Number(v.slice(0, -3));
    return Number.isNaN(n) ? null : (n * 180) / Math.PI;
  }
  if (v.endsWith('deg')) {
    const n = Number(v.slice(0, -3));
    return Number.isNaN(n) ? null : n;
  }
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function parsePercent(v: string): number | null {
  const raw = v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v);
  if (Number.isNaN(raw)) return null;
  return Math.min(1, Math.max(0, raw));
}

function parseRgbFn(t: string): RGB | null {
  const match = t.match(/^rgba?\(\s*(.+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  if (r === null || g === null || b === null) return null;
  const a = parts.length >= 4 ? parseAlpha(parts[3]) : 1;
  if (a === null) return null;
  return { r, g, b, a };
}

function hslToRgb(h: number, s: number, l: number): Pick<RGB, 'r' | 'g' | 'b'> {
  const hue = ((h % 360) + 360) % 360;
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = hue / 360;
  const pick = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: pick(hk + 1 / 3) * 255, g: pick(hk) * 255, b: pick(hk - 1 / 3) * 255 };
}

function parseHslFn(t: string): RGB | null {
  const match = t.match(/^hsla?\(\s*(.+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = parseHue(parts[0]);
  const s = parsePercent(parts[1]);
  const l = parsePercent(parts[2]);
  if (h === null || s === null || l === null) return null;
  const a = parts.length >= 4 ? parseAlpha(parts[3]) : 1;
  if (a === null) return null;
  return { ...hslToRgb(h, s, l), a };
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

function canvasColor(token: string): RGB | null {
  if (typeof document === 'undefined') return null;
  // Un seul canvas pour toute la session : en créer un par couleur inconnue
  // alloue un contexte 2D à chaque mail HTML.
  if (colorProbe === undefined) colorProbe = document.createElement('canvas').getContext('2d');
  const probe = colorProbe;
  if (!probe) return null;
  const sentinel = '#010203';
  probe.fillStyle = sentinel;
  probe.fillStyle = token;
  const out = String(probe.fillStyle);
  if (out === sentinel) return null;
  if (out.startsWith('#')) return parseHex(out);
  if (out.startsWith('rgb')) return parseRgbFn(out);
  return null;
}

function parseColor(token: string): RGB | null {
  const t = token.trim().toLowerCase();
  if (!t || NOT_A_COLOR.has(t)) return null;
  const cached = colorCache.get(t);
  if (cached !== undefined) return cached;

  let parsed: RGB | null = null;
  if (t.startsWith('#')) parsed = parseHex(t);
  else if (t.startsWith('rgb')) parsed = parseRgbFn(t);
  else if (t.startsWith('hsl')) parsed = parseHslFn(t);
  else if (BASIC[t]) parsed = parseHex(BASIC[t]);
  else if (/^[a-z]+$/.test(t) || /^(oklch|oklab|lab|lch|hwb|color)\(/.test(t)) parsed = canvasColor(t);

  colorCache.set(t, parsed);
  if (colorCache.size > COLOR_CACHE_MAX) {
    const oldest = colorCache.keys().next().value;
    if (oldest !== undefined) colorCache.delete(oldest);
  }
  return parsed;
}

function mapToken(token: string, role: MailColorRole): string {
  const parsed = parseColor(token);
  if (!parsed || parsed.a === 0) return token;
  const mapped = mapByRole(parsed, role);
  if (sameColor(parsed, mapped)) return token;
  return formatColor(mapped);
}

function replaceColors(value: string, role: MailColorRole): string {
  const holder = makeHolder();
  const masked = value.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, (url) => holder.hold(url));
  const next = masked.replace(COLOR_RE, (token) => mapToken(token, role));
  return holder.restore(next);
}

function roleForCustom(name: string): MailColorRole {
  const n = name.toLowerCase();
  if (/bg|background|surface|canvas|page/.test(n)) return 'background';
  if (/border|stroke|divider|outline/.test(n)) return 'border';
  if (/shadow/.test(n)) return 'shadow';
  if (/color|text|fg|font|link|ink|caret/.test(n)) return 'text';
  return 'ambiguous';
}

function roleFor(prop: string): MailColorRole | null {
  const raw = prop.toLowerCase();
  if (raw.startsWith('--')) return roleForCustom(raw);
  const p = raw.replace(/^-(webkit|moz|ms|o)-/, '');
  if (
    p === 'color' ||
    p === 'text-fill-color' ||
    p === 'caret-color' ||
    p === 'text-decoration-color' ||
    p === 'text-emphasis-color'
  ) {
    return 'text';
  }
  // fill/stroke are icons far more often than panels. A black glyph has to
  // become light; a white glyph has to stay white, or it vanishes on a button.
  if (p === 'fill' || p === 'stroke') return 'text';
  if (p === 'stop-color' || p === 'flood-color' || p === 'lighting-color') return 'background';
  if (p === 'background' || p === 'background-color' || p === 'background-image') return 'background';
  if (
    /^border(-[a-z]+)?$/.test(p) ||
    /^border-[a-z]+-color$/.test(p) ||
    p === 'outline' ||
    p === 'outline-color' ||
    p.startsWith('column-rule')
  ) {
    return 'border';
  }
  if (p === 'box-shadow' || p === 'text-shadow') return 'shadow';
  return null;
}

function rewriteDeclList(css: string): string {
  return css.replace(DECL_RE, (full, lead: string, prop: string, value: string) => {
    const role = roleFor(prop);
    if (!role) return full;
    const next = replaceColors(value, role);
    return next === value ? full : `${lead}${prop}: ${next.trim()}`;
  });
}

function maskCommentsAndStrings(css: string, hold: (chunk: string) => string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const j = end === -1 ? css.length : end + 2;
      out += hold(css.slice(i, j));
      i = j;
      continue;
    }
    const quote = css[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      while (j < css.length) {
        if (css[j] === '\\') {
          j += 2;
          continue;
        }
        if (css[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += hold(css.slice(i, j));
      i = j;
      continue;
    }
    out += css[i];
    i += 1;
  }
  return out;
}

function maskUrls(css: string, hold: (chunk: string) => string): string {
  return css.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, (url) => hold(url));
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function isDarkMedia(prelude: string): boolean {
  return /@media\b/i.test(prelude) && /prefers-color-scheme\s*:\s*dark/i.test(prelude);
}

function processCss(css: string, depth: number): string {
  if (depth > 40) return css;
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) {
      out += rewriteDeclList(css.slice(i));
      break;
    }
    const close = matchingBrace(css, open);
    if (close === -1) {
      out += rewriteDeclList(css.slice(i));
      break;
    }
    const prelude = css.slice(i, open);
    const inner = css.slice(open + 1, close - 1);
    if (isDarkMedia(prelude)) out += prelude + '{' + inner + '}';
    else if (inner.includes('{')) out += prelude + '{' + processCss(inner, depth + 1) + '}';
    else out += prelude + '{' + rewriteDeclList(inner) + '}';
    i = close;
  }
  return out;
}

/** Rewrite colors inside a stylesheet. Dark-scheme blocks are left untouched. */
function rewriteMailCss(css: string): string {
  const holder = makeHolder();
  let masked = maskCommentsAndStrings(css, holder.hold);
  masked = maskUrls(masked, holder.hold);
  return holder.restore(processCss(masked, 0));
}

function rewriteInlineStyle(css: string): string {
  const holder = makeHolder();
  let masked = maskCommentsAndStrings(css, holder.hold);
  masked = maskUrls(masked, holder.hold);
  return holder.restore(rewriteDeclList(masked));
}

function mapWholeColor(value: string, role: MailColorRole): string | null {
  const token = value.trim();
  const parsed = parseColor(token);
  if (!parsed || parsed.a === 0) return null;
  const mapped = mapByRole(parsed, role);
  if (sameColor(parsed, mapped)) return null;
  return formatColor(mapped);
}

const PRESENTATIONAL: { name: string; role: MailColorRole }[] = [
  { name: 'bgcolor', role: 'background' },
  { name: 'color', role: 'text' },
  { name: 'bordercolor', role: 'border' },
  { name: 'fill', role: 'text' },
  { name: 'stroke', role: 'text' },
];

/*
 * Islands — parts of a message that only work on the light page they were
 * made for. Recoloring them breaks them, so they are left as written and
 * given a light ground of their own:
 *
 *   - a barcode or QR code built from black and white cells: white cells sent
 *     to black leave a solid black square;
 *   - text laid over a photographic background: the photograph is not
 *     recolored, so the text over it must not be either;
 *   - a picture drawn in dark ink on a transparent ground (a logo, a
 *     signature): it gets a plate, see `mailPlates.ts`.
 *
 * Everything here reads inline styles and attributes only. A code or a panel
 * colored from a stylesheet class is not seen: telling which rule paints
 * which element needs a layout pass, and this module has none.
 */

/** Marks the root of a subtree whose colors are left as written. */
const KEEP_ATTR = 'data-mf-keep';
/** Marks a kept root that sits on a light ground: `code`, `panel`, or `panel-plate`. */
const LIGHT_ATTR = 'data-mf-light';
/** Marks a picture that gets a plate once it has a source. */
const PLATE_ATTR = 'data-mf-plate';

/** Light ground under artwork made for a white page. Just off white: less glare on black. */
export const MAIL_PLATE = '#f4f5f7';

/** A module of a code is black or white, nothing in between. */
const CODE_DARK = 0.03;
const CODE_LIGHT = 0.85;
/** Fewer dark cells than this is a rule or a spacer, not a code. */
const CODE_MIN_DARK = 12;
/** Share of the leaves that must be cells: a code holds almost nothing else. */
const CODE_PURITY = 0.9;
/** A label under the bars is fine; a paragraph means this is not a code. */
const CODE_MAX_TEXT = 24;

/** Names under which senders file the pictures that need a ground. */
const LOGO_HINT = /logo|brand|wordmark|signature/i;

function inlineColor(value: string | null | undefined): RGB | null {
  if (!value) return null;
  const token = value.trim();
  // `bgcolor="ffffff"`: the legacy attribute is routinely written without its hash.
  const parsed = parseColor(/^[0-9a-f]{6}$/i.test(token) ? `#${token}` : token);
  return parsed && parsed.a > 0 ? parsed : null;
}

/** What the element itself declares, inline. Stylesheet rules are not resolved. */
function ownBackground(el: Element): { color: RGB | null; image: boolean } {
  const style = (el as HTMLElement).style;
  const image = /url\(/i.test(style?.backgroundImage ?? '');
  const color = inlineColor(style?.backgroundColor) ?? inlineColor(el.getAttribute('bgcolor'));
  return { color, image };
}

function ownTextColor(el: Element): RGB | null {
  return inlineColor((el as HTMLElement).style?.color);
}

function isLightGround(color: RGB): boolean {
  return chroma(color) < VIVID && relLuminance(color) >= 0.6;
}

/**
 * Roots of barcodes and QR codes written as HTML cells. A code is a subtree
 * made almost only of empty cells, a dozen or more of them black, with no
 * running text. The widest such subtree is kept, so a label under the bars
 * stays with them.
 */
function findCodes(body: Element): Element[] {
  interface Tally {
    dark: number;
    quiet: number;
    solid: number;
    text: number;
  }
  const tallies = new Map<Element, Tally>();
  const bump = (leaf: Element, field: keyof Tally, amount: number) => {
    for (let node: Element | null = leaf; node && node !== body; node = node.parentElement) {
      let tally = tallies.get(node);
      if (!tally) {
        tally = { dark: 0, quiet: 0, solid: 0, text: 0 };
        tallies.set(node, tally);
      }
      tally[field] += amount;
    }
  };

  for (const el of body.querySelectorAll('*')) {
    if (el.firstElementChild) continue;
    const tag = el.tagName;
    if (tag === 'BR' || tag === 'STYLE' || tag === 'COL' || tag === 'WBR') continue;

    const text = (el.textContent ?? '').replace(/[\s\u00a0]/g, '');
    if (text) {
      bump(el, 'text', text.length);
      bump(el, 'solid', 1);
      continue;
    }
    if (tag === 'IMG' || tag === 'HR') {
      bump(el, 'solid', 1);
      continue;
    }

    const { color, image } = ownBackground(el);
    if (image) bump(el, 'solid', 1);
    else if (!color) bump(el, 'quiet', 1);
    else if (chroma(color) >= 0.1) bump(el, 'solid', 1);
    else if (relLuminance(color) <= CODE_DARK) bump(el, 'dark', 1);
    else if (relLuminance(color) >= CODE_LIGHT) bump(el, 'quiet', 1);
    else bump(el, 'solid', 1);
  }

  const isCode = (el: Element | null): boolean => {
    const tally = el ? tallies.get(el) : undefined;
    if (!tally || tally.dark < CODE_MIN_DARK || tally.text > CODE_MAX_TEXT) return false;
    return (tally.dark + tally.quiet) / (tally.dark + tally.quiet + tally.solid) >= CODE_PURITY;
  };

  const roots: Element[] = [];
  for (const el of tallies.keys()) {
    if (isCode(el) && !isCode(el.parentElement)) roots.push(el);
  }
  return roots;
}

/**
 * The text color a panel was written with: its own, else the first one set
 * inside it, else the nearest one above. `null` means the author relied on
 * the default, which is dark.
 */
function panelTextColor(panel: Element): RGB | null {
  const own = ownTextColor(panel);
  if (own) return own;
  for (const el of panel.querySelectorAll('[style]')) {
    const color = ownTextColor(el);
    if (color) return color;
  }
  for (let node = panel.parentElement; node; node = node.parentElement) {
    const color = ownTextColor(node);
    if (color) return color;
  }
  return null;
}

/**
 * Marks the islands of a message, before any color is rewritten: the
 * decisions read the colors the author wrote.
 */
function markIslands(body: Element): void {
  for (const code of findCodes(body)) {
    code.setAttribute(KEEP_ATTR, '');
    code.setAttribute(LIGHT_ATTR, 'code');
  }

  for (const el of body.querySelectorAll('[style]')) {
    if (el.closest(`[${KEEP_ATTR}]`)) continue;
    const ground = ownBackground(el);
    if (!ground.image) continue;
    el.setAttribute(KEEP_ATTR, '');

    // Light text was written for a dark photograph: when the photograph is
    // missing, the black page does the same job. Dark text needs a light
    // ground under the photograph, for the same case.
    const ink = panelTextColor(el);
    if (ink && relLuminance(ink) >= 0.5) continue;
    el.setAttribute(LIGHT_ATTR, ground.color ? 'panel' : 'panel-plate');
  }

  for (const img of body.querySelectorAll('img')) {
    if (img.closest(`[${KEEP_ATTR}]`)) continue;
    const src = img.getAttribute('src') ?? img.getAttribute('data-src') ?? '';
    if (!src) continue;
    const plate = /^data:image\//i.test(src)
      ? plateVerdict(src) === true
      : looksLikeLogo(img, src) && standsOnLightGround(img);
    if (plate) img.setAttribute(PLATE_ATTR, '');
  }
}

/**
 * A remote picture cannot be looked at (see `mailPlates.ts`), so it is judged
 * by what it is called. JPEG has no transparency: a plate would never show.
 */
function looksLikeLogo(img: Element, src: string): boolean {
  let file = '';
  try {
    file = decodeURIComponent(new URL(src, 'https://mail.invalid/').pathname.split('/').pop() ?? '');
  } catch {
    file = src;
  }
  if (/\.jpe?g$/i.test(file)) return false;
  const named = [file, img.getAttribute('alt'), img.getAttribute('title'), img.getAttribute('class')];
  return named.some((value) => value != null && LOGO_HINT.test(value));
}

/** A logo set on a dark or colored band was drawn for that band: no plate there. */
function standsOnLightGround(img: Element): boolean {
  for (let node = img.parentElement; node; node = node.parentElement) {
    const ground = ownBackground(node);
    if (ground.image) return false;
    if (ground.color) return isLightGround(ground.color);
  }
  return true;
}

function rewritePresentational(root: Element): void {
  const elements = [root, ...root.querySelectorAll('*')];
  for (const el of elements) {
    if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
    if (el.closest(`[${KEEP_ATTR}]`)) continue;

    const style = el.getAttribute('style');
    if (style) {
      const next = rewriteInlineStyle(style);
      if (next !== style) el.setAttribute('style', next);
    }

    for (const { name, role } of PRESENTATIONAL) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const next = mapWholeColor(value, role);
      if (next) el.setAttribute(name, next);
    }
  }
}

/**
 * The HTML parser promotes a leading `<style>` into `<head>`. Serializing only
 * `body.innerHTML` would drop the sheet, and with it every class color.
 */
export function serializeFragment(doc: Document): string {
  const headStyles = [...doc.head.querySelectorAll('style')].map((el) => el.outerHTML).join('');
  return headStyles + doc.body.innerHTML;
}

/**
 * Recolor an HTML mail fragment for a black page. Pictures are not repainted;
 * the ones drawn for a white page get a light plate, like the other islands.
 */
export function adaptMailToDark(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const styleEl of doc.querySelectorAll('style')) {
    const media = styleEl.getAttribute('media') ?? '';
    if (/prefers-color-scheme\s*:\s*dark/i.test(media)) continue;
    const css = styleEl.textContent ?? '';
    const next = rewriteMailCss(css);
    if (next !== css) styleEl.textContent = next;
  }

  markIslands(doc.body);
  rewritePresentational(doc.body);
  return serializeFragment(doc);
}

/**
 * Applied after the author's stylesheet. The reading pane is the only
 * scroller: the frame grows with the message and must not scroll itself.
 */
export function mailFrameLockCss(): string {
  return `
    html, body {
      height: auto !important;
      overflow: hidden !important;
    }
    .mf-root {
      height: auto !important;
      max-height: none !important;
      overflow: visible !important;
    }
    .mf-root img, .mf-root svg, .mf-root video, .mf-root table {
      max-width: 100% !important;
    }
  `;
}

/** Default canvas for the message iframe. Author styles override it. */
export function mailFrameCss(dark: boolean): string {
  const page = dark ? '#000000' : '#ffffff';
  const ink = dark ? '#f4f4f5' : '#1b1d23';
  const link = dark ? '#8ab4f8' : '#1a56c4';
  const quote = dark ? '#c4c4cc' : '#5c6370';
  const quoteRule = dark ? '#3f3f46' : '#d0d4dc';

  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    html, body, .mf-root {
      background: ${page};
      color: ${ink};
      font: 14px/1.6 -apple-system, 'Segoe UI', sans-serif;
      word-break: break-word;
    }
    html, body { margin: 0; padding: 0; }
    .mf-root { padding: 20px; }
    a { color: ${link}; }
    img, svg { max-width: 100%; height: auto; }
    pre { white-space: pre-wrap; font: inherit; margin: 0; }
    table { max-width: 100%; }
    blockquote {
      margin: 0 0 0 8px;
      padding-left: 12px;
      border-left: 2px solid ${quoteRule};
      color: ${quote};
    }
    mark.mf-hit {
      background: #f6c66a;
      color: #1b1d23;
      border-radius: 2px;
      padding: 0 1px;
    }
    ${dark ? mailIslandCss() : ''}
  `;
}

/**
 * Grounds for the islands marked by `adaptMailToDark`. The ring is a shadow,
 * not padding: it gives the artwork a margin without moving the layout.
 * A code is read by a camera, so its ground is pure white, with a quiet zone.
 */
function mailIslandCss(): string {
  return `
    [${LIGHT_ATTR}] { color: #1b1d23; }
    [${LIGHT_ATTR}] a { color: #1a56c4; }
    [${LIGHT_ATTR}='code'] {
      background-color: #ffffff !important;
      box-shadow: 0 0 0 8px #ffffff;
    }
    [${LIGHT_ATTR}='panel-plate'] { background-color: ${MAIL_PLATE} !important; }
    img[${PLATE_ATTR}][src] {
      background-color: ${MAIL_PLATE} !important;
      border-radius: 3px;
      box-shadow: 0 0 0 3px ${MAIL_PLATE};
    }
  `;
}
