/**
 * Turns the compose document into a plain-text body and, when it carries
 * formatting or screenshots, an HTML body. The HTML is rebuilt here from the
 * editor's document, never taken from the editor's DOM.
 */

/** Clipboard images we will render. SVG is excluded: it can carry script. */
const INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

const GENERIC_IMAGE_NAMES = new Set([
  'image.png',
  'image.jpeg',
  'image.jpg',
  'image.webp',
  'image.gif',
  'image.bmp',
  'blob',
]);

/** Same shape `crypto.randomUUID()` produces. Anything else is not one of our images. */
const INLINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInlineImageType(type: string): boolean {
  return INLINE_IMAGE_TYPES.has(type.toLowerCase());
}

export function extensionForImage(type: string): string {
  switch (type.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}

/** Windows and Chromium name a clipboard bitmap `image.png`. That is not a file the user chose. */
export function shouldRenameClipboardImage(name: string): boolean {
  const base = name.split(/[/\\]/).pop()?.trim().toLowerCase() ?? '';
  return base === '' || GENERIC_IMAGE_NAMES.has(base);
}

export function captureFilename(taken: Iterable<string>, date = new Date(), extension = 'png'): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const base = `capture-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const used = new Set(taken);
  let name = `${base}.${extension}`;
  let index = 2;
  while (used.has(name)) {
    name = `${base}-${index}.${extension}`;
    index += 1;
  }
  return name;
}

export function fileForClipboardImage(file: File, taken: Set<string>): File {
  const type = isInlineImageType(file.type) ? file.type : 'image/png';
  if (!shouldRenameClipboardImage(file.name) && isInlineImageType(file.type)) return file;
  const name = captureFilename(taken, new Date(), extensionForImage(type));
  taken.add(name);
  if (name === file.name && type === file.type) return file;
  return new File([file], name, { type, lastModified: file.lastModified });
}

export function filesFromClipboard(data: DataTransfer | null): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  if (!data) return { images, others };

  const push = (file: File | null, type: string) => {
    if (!file || file.size <= 0) return;
    const resolved = type || file.type;
    if (isInlineImageType(resolved)) {
      images.push(resolved === file.type ? file : new File([file], file.name || 'image.png', { type: resolved }));
      return;
    }
    others.push(file);
  };

  if (data.items?.length) {
    for (const item of data.items) {
      if (item.kind !== 'file') continue;
      push(item.getAsFile(), item.type);
    }
  }
  if (!images.length && !others.length) {
    for (const file of data.files) push(file, file.type);
  }
  return { images, others };
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formatting the composer offers. Each one maps to an inline style that Outlook
 * (Word engine), Gmail and Apple Mail all render: no classes, no stylesheet,
 * no web fonts. `outgoingHtml.ts` on the server enforces the same shapes.
 */
export const FONT_FAMILIES = [
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Trebuchet', value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: "'Times New Roman', Times, serif" },
  { label: 'Courier', value: "'Courier New', Courier, monospace" },
] as const;

export const FONT_SIZES = ['12px', '14px', '16px', '18px', '24px', '32px'] as const;

export const TEXT_COLORS = [
  '#1f2328',
  '#6b7280',
  '#c62828',
  '#e65100',
  '#2e7d32',
  '#1565c0',
  '#6a1b9a',
  '#ad1457',
] as const;

export const HIGHLIGHT_COLORS = ['#fff59d', '#c8e6c9', '#bbdefb', '#f8bbd0', '#ffe0b2', '#e0e0e0'] as const;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Only web and mail links. A bare host gets `https://`; any other scheme is dropped. */
export function safeHref(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const href = input.trim();
  if (!href || /[\s<>"]/.test(href)) return null;
  if (/^(?:https?:\/\/|mailto:)/i.test(href)) return href;
  if (URL_SCHEME.test(href) || href.startsWith('/')) return null;
  if (/^[^@/]+@[^@/]+\.[^@/]+$/.test(href)) return `mailto:${href}`;
  return `https://${href}`;
}

/** The subset of TipTap's `getJSON()` this serializer reads. */
export interface ComposeDoc {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: ComposeDoc[];
}

export interface SerializedBody {
  text: string;
  html: string;
  imageIds: string[];
  /** False when the message is plain text only: it is then sent without HTML. */
  rich: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A run of spaces survives mail clients that collapse HTML whitespace. */
function htmlText(value: string): string {
  return escapeHtml(value.replace(/\t/g, '    ')).replace(/ {2,}/g, (run) => '&nbsp;'.repeat(run.length));
}

/** A style re-read from the DOM comes back as `rgb()`: the browser normalizes it. */
function hexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (HEX_COLOR.test(value)) return value.toLowerCase();
  const rgb = RGB_COLOR.exec(value);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((channel) => channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function textStyle(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return '';
  const parts: string[] = [];
  const { fontFamily, fontSize } = attrs;
  const color = hexColor(attrs.color);
  const backgroundColor = hexColor(attrs.backgroundColor);
  if (color) parts.push(`color:${color}`);
  if (backgroundColor) parts.push(`background-color:${backgroundColor}`);
  const family = FONT_FAMILIES.find((font) => font.value === fontFamily);
  if (family) parts.push(`font-family:${family.value}`);
  if (FONT_SIZES.includes(fontSize as (typeof FONT_SIZES)[number])) parts.push(`font-size:${fontSize}`);
  return parts.join(';');
}

/** Tags nest outermost first: a colored span outside `<u>` gives the underline that color. */
function wrapText(node: ComposeDoc): { html: string; href: string | null; styled: boolean } {
  let html = htmlText(node.text ?? '');
  let href: string | null = null;
  let style = '';
  const tags: string[] = [];
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') tags.push('strong');
    else if (mark.type === 'italic') tags.push('em');
    else if (mark.type === 'underline') tags.push('u');
    else if (mark.type === 'strike') tags.push('s');
    else if (mark.type === 'link') href = safeHref(mark.attrs?.href);
    else if (mark.type === 'textStyle') style = textStyle(mark.attrs);
  }
  for (const tag of ['s', 'u', 'em', 'strong']) {
    if (tags.includes(tag)) html = `<${tag}>${html}</${tag}>`;
  }
  if (style) html = `<span style="${escapeAttr(style)}">${html}</span>`;
  if (href) html = `<a href="${escapeAttr(href)}">${html}</a>`;
  return { html, href, styled: tags.length > 0 || style !== '' || href !== null };
}

export function serializeDoc(doc: ComposeDoc, knownIds: ReadonlySet<string>): SerializedBody {
  const imageIds: string[] = [];
  let rich = false;
  const blocks: { text: string; html: string }[] = [];

  for (const block of doc.content ?? []) {
    const text: string[] = [];
    const html: string[] = [];
    // A link split by a bold word is several text nodes: its URL goes once, after the last one.
    let linkText = '';
    let linkHref: string | null = null;
    const flushLink = () => {
      if (linkHref) {
        const bare = linkHref.replace(/^mailto:/i, '');
        if (linkText.trim() !== linkHref && linkText.trim() !== bare) text.push(` (${bare})`);
      }
      linkHref = null;
      linkText = '';
    };

    for (const node of block.content ?? []) {
      if (node.type === 'text') {
        const wrapped = wrapText(node);
        if (wrapped.href !== linkHref) flushLink();
        if (wrapped.href) {
          linkHref = wrapped.href;
          linkText += node.text ?? '';
        }
        rich ||= wrapped.styled;
        text.push(node.text ?? '');
        html.push(wrapped.html);
        continue;
      }
      flushLink();
      if (node.type === 'hardBreak') {
        text.push('\n');
        html.push('<br>');
      } else if (node.type === 'inlineImage') {
        const id = typeof node.attrs?.id === 'string' ? node.attrs.id : '';
        if (!knownIds.has(id) || !INLINE_ID.test(id) || imageIds.includes(id)) continue;
        imageIds.push(id);
        rich = true;
        const raw = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
        const alt = raw.replace(/[\r\n"]/g, ' ').trim().slice(0, 180) || 'capture';
        text.push(`[${alt}]`);
        html.push(`<img src="cid:${id}" alt="${escapeAttr(alt)}">`);
      }
    }
    flushLink();
    blocks.push({ text: text.join(''), html: html.join('').replace(/(?:<br>)+$/, '') });
  }

  while (blocks.length && blocks[blocks.length - 1].text.trim() === '' && !blocks[blocks.length - 1].html.includes('<img')) {
    blocks.pop();
  }

  return {
    text: blocks.map((block) => block.text).join('\n').replace(/\s+$/, ''),
    // One div per paragraph, an empty one kept as a blank line: the shape Gmail itself sends.
    html: blocks.length ? blocks.map((block) => `<div>${block.html || '<br>'}</div>`).join('') : '',
    imageIds,
    rich,
  };
}
