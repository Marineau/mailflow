import { useEffect, useMemo, useState } from 'react';

/**
 * Which pictures of a message need a light plate under them in dark mode.
 *
 * A logo drawn in black on a transparent background was made for a white
 * page: on the black one it disappears. The only reliable way to tell such a
 * picture from a photograph or a colored icon is to look at its pixels —
 * transparent around, dark where it is drawn.
 *
 * Pixels can only be read from pictures that travel inside the message (data
 * URIs, attachments). A remote picture is cross-origin: the canvas refuses to
 * give its pixels back, and fetching it another way would mean loading a
 * tracker the user did not ask for. Those are judged by name in `darkMail.ts`.
 */

/** Side of the thumbnail the pixels are read from. A verdict needs shapes, not detail. */
const SAMPLE = 48;

/** Below this alpha a pixel shows the page through. */
const CLEAR_ALPHA = 24;

/** A tenth of the picture must be see-through, or there is no page to show through. */
const MIN_CLEAR_SHARE = 0.1;

/** Ink darker than this is unreadable on black (under about 3.4:1). */
const DARK_INK = 0.12;

/** Share of the drawn pixels, weighted by opacity, that must be dark. */
const MIN_DARK_SHARE = 0.6;

/** Longer data URIs are heavy pictures, shown on request outside the message HTML. */
const MAX_INLINE_CHARS = 70_000;

/** Never hold the message back longer than this for a verdict. */
const VERDICT_WAIT_MS = 250;

const VERDICT_CACHE_MAX = 300;

const verdicts = new Map<string, boolean>();
const pending = new Map<string, Promise<boolean>>();

let probe: CanvasRenderingContext2D | null | undefined;

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** A data URI can weigh tens of kilobytes: the cache is keyed by a digest, not by the string. */
function digest(src: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < src.length; i += 1) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${src.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * True when a decoded picture is dark artwork on a transparent ground.
 * Returns false when the pixels cannot be read (cross-origin, canvas refused).
 */
export function needsPlate(image: HTMLImageElement): boolean {
  const { naturalWidth, naturalHeight } = image;
  if (!naturalWidth || !naturalHeight) return false;
  if (probe === undefined) {
    probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  }
  if (!probe) return false;

  const scale = Math.min(1, SAMPLE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  probe.canvas.width = width;
  probe.canvas.height = height;

  let pixels: Uint8ClampedArray;
  try {
    probe.clearRect(0, 0, width, height);
    probe.drawImage(image, 0, 0, width, height);
    pixels = probe.getImageData(0, 0, width, height).data;
  } catch {
    return false;
  }

  let clear = 0;
  let ink = 0;
  let darkInk = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha < CLEAR_ALPHA) {
      clear += 1;
      continue;
    }
    const luminance =
      0.2126 * channel(pixels[i]) + 0.7152 * channel(pixels[i + 1]) + 0.0722 * channel(pixels[i + 2]);
    ink += alpha;
    if (luminance < DARK_INK) darkInk += alpha;
  }

  if (ink === 0) return false;
  return clear / (width * height) >= MIN_CLEAR_SHARE && darkInk / ink >= MIN_DARK_SHARE;
}

/** The verdict for an inline picture, or `undefined` while it has not been looked at. */
export function plateVerdict(src: string): boolean | undefined {
  return verdicts.get(digest(src));
}

function remember(key: string, verdict: boolean) {
  verdicts.set(key, verdict);
  if (verdicts.size > VERDICT_CACHE_MAX) {
    const oldest = verdicts.keys().next().value;
    if (oldest !== undefined) verdicts.delete(oldest);
  }
}

function analyse(src: string): Promise<boolean> {
  const key = digest(src);
  const known = verdicts.get(key);
  if (known !== undefined) return Promise.resolve(known);
  const running = pending.get(key);
  if (running) return running;

  const job = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(needsPlate(image));
    image.onerror = () => resolve(false);
    image.src = src;
  }).then((verdict) => {
    remember(key, verdict);
    pending.delete(key);
    return verdict;
  });
  pending.set(key, job);
  return job;
}

/** Data URIs of the pictures written into the message HTML. */
function inlineSources(html: string): string[] {
  const found = new Set<string>();
  const pattern = /<img\b[^>]*?\ssrc\s*=\s*(["'])(data:image\/[^"']+)\1/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[2].length <= MAX_INLINE_CHARS) found.add(match[2]);
  }
  return [...found];
}

/**
 * Looks at the inline pictures of a message before it is drawn. Returns false
 * while verdicts are still on their way: drawing first and adding the plates
 * afterwards would reload the whole message frame under the reader's eyes.
 */
export function useInlinePlates(html: string | null, enabled: boolean): boolean {
  const unknown = useMemo(
    () => (enabled && html ? inlineSources(html).filter((src) => plateVerdict(src) === undefined) : []),
    [html, enabled],
  );
  const [settled, setSettled] = useState<string | null>(null);

  useEffect(() => {
    if (unknown.length === 0) return;
    let cancelled = false;
    const finish = () => {
      if (!cancelled) setSettled(html);
    };
    const timer = window.setTimeout(finish, VERDICT_WAIT_MS);
    void Promise.all(unknown.map(analyse)).then(finish);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [unknown, html]);

  return unknown.length === 0 || settled === html;
}
