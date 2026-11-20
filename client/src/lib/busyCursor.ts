/**
 * Animated "working in background" cursor, one per theme.
 *
 * Every loader of the interface (skeletons, sync bar, spinning icons) calls
 * `useBusyCursor(active)`. While at least one is active, <html> carries
 * `data-busy` and the `--mf-busy-cursor` variable, which `index.css` turns into
 * the cursor. The cursor is inherited, so it replaces the plain arrow only:
 * a link keeps its hand, a text field its I-beam, as on Windows.
 *
 * Why frames from JS and not CSS keyframes: browsers ignore animated cursor
 * files (.ani, animated GIF), and a `cursor` animated by @keyframes is not
 * reliably repainted. Writing one static SVG frame at a time is: the browser
 * swaps the cursor as soon as the computed value changes.
 *
 * The three Windows themes copy the real cursors (AppStarting): Classique
 * gets the pixel arrow and the hourglass that drains then flips, Vista the
 * glass ring with its bright swirl, 11 the flat blue ring. The other themes
 * get a cursor drawn in their own colors. Frames are 32 × 32, the size a
 * cursor has on Windows at 100 %.
 */
import { useEffect } from 'react';

interface CursorSet {
  frames: string[];
  /** Milliseconds per frame. */
  interval: number;
}

const SIZE = 32;

function toCursor(body: string, hotX: number, hotY: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" ` +
    `viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, progress`;
}

/* ── Pixel arrow (Classique, Récif) ─────────────────────────────── */

/**
 * The standard Windows arrow, pixel for pixel: B = outline, W = fill.
 * 12 × 19, hotspot on the top-left pixel.
 */
const PIXEL_ARROW = [
  'B',
  'BB',
  'BWB',
  'BWWB',
  'BWWWB',
  'BWWWWB',
  'BWWWWWB',
  'BWWWWWWB',
  'BWWWWWWWB',
  'BWWWWWWWWB',
  'BWWWWWWWWWB',
  'BWWWWWWBBBBB',
  'BWWWBWWB',
  'BWWB BWWB',
  'BWB  BWWB',
  'BB    BWWB',
  'B     BWWB',
  '       BWWB',
  '       BBB',
];

function pixelArrow(outline: string, fill: string): string {
  let rects = '';
  PIXEL_ARROW.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === 'B' || cell === 'W') {
        rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${cell === 'B' ? outline : fill}"/>`;
      }
    });
  });
  return `<g shape-rendering="crispEdges">${rects}</g>`;
}

/* ── Vector arrow (Vista, 11, mailFlow, Arène) ────────────────── */

const ARROW_PATH = 'M1.5 1.5 L1.5 18.5 L5.6 14.6 L8.4 21 L11 19.9 L8.3 13.6 L13.8 13.6 Z';

function vectorArrow({
  outline = '#000',
  fill = '#fff',
  shadow = 0,
}: { outline?: string; fill?: string; shadow?: number } = {}): string {
  const drop = shadow
    ? `<path d="${ARROW_PATH}" transform="translate(1.2 1.4)" fill="#000" opacity="${shadow}"/>`
    : '';
  return `${drop}<path d="${ARROW_PATH}" fill="${fill}" stroke="${outline}" stroke-width="1" stroke-linejoin="miter"/>`;
}

/* ── Classique: arrow + hourglass ────────────────────────────────────── */

const GLASS =
  'M1.5 2 L9.5 2 L9.5 4.5 L6.5 7.5 L6.5 8.5 L9.5 11.5 L9.5 14 L1.5 14 L1.5 11.5 L4.5 8.5 L4.5 7.5 L1.5 4.5 Z';

/** `level` = share of the sand still in the top bulb, 1 → 0. */
function hourglass(level: number, angle: number): string {
  const topHeight = 5.5 * level;
  const bottomHeight = 5.5 * (1 - level);
  const stream =
    level > 0 && level < 1
      ? `<rect x="5" y="7.5" width="1" height="${(13.5 - bottomHeight - 7.5).toFixed(2)}" fill="#000"/>`
      : '';
  return (
    `<g transform="translate(14 9) rotate(${angle} 5.5 8)">` +
    `<defs><clipPath id="g"><path d="${GLASS}"/></clipPath></defs>` +
    `<path d="${GLASS}" fill="#fff"/>` +
    `<g clip-path="url(#g)" shape-rendering="crispEdges">` +
    `<rect x="0" y="${(8 - topHeight).toFixed(2)}" width="11" height="${topHeight.toFixed(2)}" fill="#000"/>` +
    `<rect x="0" y="${(14 - bottomHeight).toFixed(2)}" width="11" height="${bottomHeight.toFixed(2)}" fill="#000"/>` +
    stream +
    `</g>` +
    `<path d="${GLASS}" fill="none" stroke="#000" stroke-width="1"/>` +
    `<rect x="0" y="0" width="11" height="2" fill="#000" shape-rendering="crispEdges"/>` +
    `<rect x="0" y="14" width="11" height="2" fill="#000" shape-rendering="crispEdges"/>` +
    `</g>`
  );
}

function win98(): CursorSet {
  const arrow = pixelArrow('#000', '#fff');
  const frames: string[] = [];
  // Sand drains in six steps, then the glass turns over in three.
  for (const level of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
    frames.push(toCursor(arrow + hourglass(level, 0), 0, 0));
  }
  for (const angle of [45, 90, 135]) {
    frames.push(toCursor(arrow + hourglass(0, angle), 0, 0));
  }
  return { frames, interval: 140 };
}

/* ── Rings (Vista, 11, mailFlow) ──────────────────────────────────────── */

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(from));
  const y1 = cy + r * Math.sin(rad(from));
  const x2 = cx + r * Math.cos(rad(to));
  const y2 = cy + r * Math.sin(rad(to));
  const large = to - from > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** A comet: `steps` short arcs whose opacity fades from the head backwards. */
function comet(
  cx: number,
  cy: number,
  r: number,
  head: number,
  length: number,
  color: string,
  width: number,
  steps = 8,
): string {
  let out = '';
  const span = length / steps;
  for (let i = 0; i < steps; i++) {
    const to = head - i * span;
    const opacity = (1 - i / steps).toFixed(2);
    out += `<path d="${arc(cx, cy, r, to - span - 0.5, to)}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}"/>`;
  }
  return out;
}

function vista(): CursorSet {
  const arrow = vectorArrow({ shadow: 0.35 });
  const cx = 22;
  const cy = 22;
  const frames: string[] = [];
  const count = 18;
  for (let i = 0; i < count; i++) {
    const head = (360 / count) * i;
    const ring =
      `<defs><radialGradient id="v" cx="0.5" cy="0.35" r="0.6">` +
      `<stop offset="0" stop-color="#8fe3ff"/><stop offset="1" stop-color="#1a6fc9"/>` +
      `</radialGradient></defs>` +
      `<circle cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="#0a3a6e" stroke-width="5"/>` +
      `<circle cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="url(#v)" stroke-width="3.4"/>` +
      comet(cx, cy, 7.5, head, 150, '#e9fbff', 3, 10) +
      `<path d="${arc(cx, cy, 7.5, 300, 400)}" fill="none" stroke="#fff" stroke-width="1" opacity="0.45"/>`;
    frames.push(toCursor(arrow + ring, 1, 1));
  }
  return { frames, interval: 50 };
}

function win11(): CursorSet {
  const arrow = vectorArrow();
  const cx = 22;
  const cy = 22;
  const frames: string[] = [];
  const count = 18;
  for (let i = 0; i < count; i++) {
    const head = (360 / count) * i;
    const ring =
      `<circle cx="${cx}" cy="${cy}" r="7" fill="none" stroke="#fff" stroke-width="5"/>` +
      `<circle cx="${cx}" cy="${cy}" r="7" fill="none" stroke="#0067c0" stroke-width="3"/>` +
      comet(cx, cy, 7, head, 200, '#6cc4ff', 3, 10);
    frames.push(toCursor(arrow + ring, 1, 1));
  }
  return { frames, interval: 50 };
}

function mailflow(): CursorSet {
  const arrow = vectorArrow({ shadow: 0.25 });
  const cx = 22;
  const cy = 22;
  const frames: string[] = [];
  const count = 12;
  for (let i = 0; i < count; i++) {
    const head = (360 / count) * i;
    const ring =
      `<circle cx="${cx}" cy="${cy}" r="6" fill="#111827" opacity="0.85"/>` +
      `<path d="${arc(cx, cy, 4, head, head + 270)}" fill="none" stroke="#6f9cff" stroke-width="2" stroke-linecap="round"/>`;
    frames.push(toCursor(arrow + ring, 1, 1));
  }
  return { frames, interval: 70 };
}

/* ── Récif: pixel arrow + rising bubbles ─────────────────────────── */

/** A pixel bubble, drawn with 2-pixel cells like the theme's own artwork. */
function bubble(x: number, y: number, size: 2 | 3 | 4): string {
  const edge = '#bdf3ff';
  const glint = '#ffffff';
  const dark = '#06283a';
  const u = 2;
  const cell = (cx: number, cy: number, color: string) =>
    `<rect x="${x + cx * u}" y="${y + cy * u}" width="${u}" height="${u}" fill="${color}"/>`;
  // One dark cell-wide halo behind, so the bubble reads on a light page too.
  const halo = `<rect x="${x - 1}" y="${y - 1}" width="${size * u + 2}" height="${size * u + 2}" fill="${dark}" opacity="0.5"/>`;
  if (size === 2) return halo + cell(0, 0, glint) + cell(1, 0, edge) + cell(0, 1, edge) + cell(1, 1, edge);
  if (size === 3) {
    return halo + cell(1, 0, edge) + cell(0, 1, edge) + cell(2, 1, edge) + cell(1, 2, edge) + cell(0, 0, glint);
  }
  return (
    halo +
    cell(1, 0, edge) + cell(2, 0, edge) + cell(0, 1, edge) + cell(3, 1, edge) +
    cell(0, 2, edge) + cell(3, 2, edge) + cell(1, 3, edge) + cell(2, 3, edge) + cell(1, 1, glint)
  );
}

function waterraria(): CursorSet {
  const arrow = pixelArrow('#06283a', '#ffffff');
  const frames: string[] = [];
  const count = 8;
  // Three bubbles climbing 16 pixels, out of phase, swaying by one pixel.
  const lanes: Array<{ x: number; size: 2 | 3 | 4; phase: number }> = [
    { x: 13, size: 4, phase: 0 },
    { x: 22, size: 3, phase: 6 },
    { x: 27, size: 2, phase: 11 },
  ];
  for (let i = 0; i < count; i++) {
    let bubbles = '';
    for (const lane of lanes) {
      const y = 24 - ((i * 2 + lane.phase) % 16);
      const sway = (i + lane.phase) % 4 < 2 ? 0 : 1;
      bubbles += bubble(lane.x + sway, y, lane.size);
    }
    frames.push(toCursor(`<g shape-rendering="crispEdges">${bubbles}</g>` + arrow, 0, 0));
  }
  return { frames, interval: 110 };
}

/* ── Arène: arrow + boost gauge filling up ────────────────────── */

function pocket(): CursorSet {
  const arrow = vectorArrow({ outline: '#0a1640', shadow: 0.3 });
  const cx = 22;
  const cy = 22;
  const segments = 10;
  const frames: string[] = [];
  for (let filled = 0; filled <= segments; filled++) {
    let gauge = `<circle cx="${cx}" cy="${cy}" r="8.5" fill="#0a1640" opacity="0.9"/>`;
    for (let s = 0; s < segments; s++) {
      const from = (360 / segments) * s + 4;
      const to = (360 / segments) * (s + 1) - 4;
      const color = s < filled ? '#ff7a18' : '#2b6bff';
      const opacity = s < filled ? 1 : 0.55;
      gauge += `<path d="${arc(cx, cy, 6.5, from, to)}" fill="none" stroke="${color}" stroke-width="3" opacity="${opacity}"/>`;
    }
    gauge += `<circle cx="${cx}" cy="${cy}" r="8.5" fill="none" stroke="#5aa8ff" stroke-width="1"/>`;
    frames.push(toCursor(arrow + gauge, 1, 1));
  }
  return { frames, interval: 90 };
}

/* ── Papeterie: arrow + a hopping wedge of cheese ────────────────────── */

function tiddl(): CursorSet {
  const arrow = vectorArrow({ outline: '#3a2f5b', shadow: 0.2 });
  const count = 10;
  const ground = 30;
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const lift = 8 * Math.sin(Math.PI * t);
    // Squashed on landing, stretched at take-off.
    const squash = i === 0 ? 0.78 : i === 1 || i === count - 1 ? 1.08 : 1;
    const shadowWidth = 6.5 - lift * 0.35;
    const wedge =
      `<g transform="translate(17 ${(ground - lift).toFixed(2)}) scale(1 ${squash}) translate(0 -9)">` +
      `<path d="M0.5 8.5 L13 8.5 L13 1.5 Z" fill="#ffd34d" stroke="#b9771a" stroke-width="1" stroke-linejoin="round"/>` +
      `<path d="M13 1.5 L13 8.5" stroke="#eaa91f" stroke-width="1.6"/>` +
      `<circle cx="8.6" cy="6.4" r="1.2" fill="#eaa91f"/>` +
      `<circle cx="11" cy="4.6" r="0.8" fill="#eaa91f"/>` +
      `</g>`;
    const shade = `<ellipse cx="24" cy="${ground + 0.5}" rx="${shadowWidth.toFixed(2)}" ry="1.2" fill="#3a2f5b" opacity="0.25"/>`;
    frames.push(toCursor(shade + wedge + arrow, 1, 1));
  }
  return { frames, interval: 70 };
}

/* ── Runtime ──────────────────────────────────────────────────────────── */

const BUILDERS: Record<string, () => CursorSet> = {
  mailflow,
  vista,
  win98,
  win11,
  waterraria,
  pocket,
  tiddl,
};

const cache = new Map<string, CursorSet>();

/** Also handy from the console to look at a theme's frames. */
export function cursorsFor(theme: string): CursorSet {
  const id = theme in BUILDERS ? theme : 'mailflow';
  let set = cache.get(id);
  if (!set) {
    set = BUILDERS[id]();
    cache.set(id, set);
  }
  return set;
}

let active = 0;
let timer: number | undefined;
let frame = 0;
let currentTheme = '';

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function tick() {
  const root = document.documentElement;
  const theme = root.dataset.theme ?? 'mailflow';
  const set = cursorsFor(theme);
  if (theme !== currentTheme) {
    currentTheme = theme;
    frame = 0;
    // Theme changed mid-load: restart at that theme's pace.
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = reducedMotion() ? undefined : window.setInterval(tick, set.interval);
    }
  }
  root.style.setProperty('--mf-busy-cursor', set.frames[frame % set.frames.length]);
  frame += 1;
}

function start() {
  const root = document.documentElement;
  root.dataset.busy = '';
  currentTheme = '';
  frame = 0;
  // A placeholder id: the first tick() sees a "theme change" and installs the
  // real interval, at that theme's pace (or none under reduced motion).
  timer = -1;
  tick();
}

function stop() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  const root = document.documentElement;
  delete root.dataset.busy;
  root.style.removeProperty('--mf-busy-cursor');
}

/** Shows the busy cursor for as long as `on` is true and the caller is mounted. */
export function useBusyCursor(on = true) {
  useEffect(() => {
    if (!on) return;
    active += 1;
    if (active === 1) start();
    return () => {
      active -= 1;
      if (active === 0) stop();
    };
  }, [on]);
}
