/** Same cutoff as the server: photos above this never enter the message DOM. */
const HEAVY_BYTES = 48 * 1024;
const HEAVY_DATA_CHARS = Math.ceil((HEAVY_BYTES * 4) / 3);

export interface PeeledPicture {
  name: string;
  /** Index into the message attachments, when the bytes are already stored. */
  file: number | null;
  /** Data URI held back until the button for this picture is pressed. */
  inlineSrc: string | null;
  size: number | null;
}

export type MailPart =
  | { type: 'html'; html: string }
  | { type: 'image'; picture: PeeledPicture };

/**
 * Lifts heavy pictures out of the HTML before it is parsed or painted.
 * A data URI stays in memory, on the picture record, and is not written back
 * into the document. `data-file` pictures point at an attachment instead.
 */
export function peelHeavyPictures(
  html: string,
  attachments: { filename: string; size: number }[],
): { html: string; pictures: PeeledPicture[] } {
  const pictures: PeeledPicture[] = [];
  const next = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const fileAttr = readAttr(tag, 'data-file');
    const src = readAttr(tag, 'src');
    const name = decodeAttr(readAttr(tag, 'alt') ?? '');

    if (fileAttr != null && /^\d+$/.test(fileAttr)) {
      const file = Number(fileAttr);
      const meta = attachments[file];
      const id = pictures.length;
      pictures.push({
        name: name || meta?.filename || 'Image',
        file,
        inlineSrc: null,
        size: meta?.size ?? null,
      });
      return `<span data-mf-split="${id}"></span>`;
    }

    if (src && /^data:image\//i.test(src) && src.length > HEAVY_DATA_CHARS) {
      const id = pictures.length;
      pictures.push({
        name: name || 'Image',
        file: null,
        inlineSrc: src,
        size: estimateBytes(src),
      });
      return `<span data-mf-split="${id}"></span>`;
    }

    return tag;
  });
  return { html: next, pictures };
}

/**
 * One parse for both the author stylesheet and the body fragments.
 * Parsing the mail twice built two full documents on every open.
 */
export function layoutFragment(
  fragment: string,
  pictures: PeeledPicture[],
): { css: string; parts: MailPart[] } {
  const stripped = fragmentWithoutStyles(fragment);
  const css = flattenMailScroll(retargetBody(stripped.css));
  if (pictures.length === 0) {
    const html = stripped.html;
    return { css, parts: html.trim() ? [{ type: 'html', html }] : [] };
  }

  const bits = stripped.html.split(/<span data-mf-split="(\d+)"\s*(?:\/>|><\/span>)/i);
  const parts: MailPart[] = [];

  for (let i = 0; i < bits.length; i += 1) {
    if (i % 2 === 0) {
      if (!isBlank(bits[i])) parts.push({ type: 'html', html: bits[i] });
      continue;
    }
    const picture = pictures[Number(bits[i])];
    if (picture) parts.push({ type: 'image', picture });
  }

  return { css, parts };
}

function fragmentWithoutStyles(fragment: string): { html: string; css: string } {
  const doc = new DOMParser().parseFromString(fragment, 'text/html');
  const css = [...doc.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
  doc.querySelectorAll('style').forEach((style) => style.remove());
  return { html: releaseInlineScroll(doc.body.innerHTML), css: css.replace(/<\/style/gi, '') };
}

function releaseInlineScroll(html: string): string {
  return html.replace(/style="([^"]*)"/gi, (full, style: string) => {
    if (!/overflow(?:-[xy])?\s*:\s*(?:auto|scroll)\b/i.test(style)) return full;
    const next = style
      .replace(/overflow(-[xy])?\s*:\s*(?:auto|scroll)\b/gi, 'overflow$1:visible')
      .replace(/max-height\s*:\s*[^;]+;?/gi, '');
    return `style="${next}"`;
  });
}

function retargetBody(css: string): string {
  return css.replace(/\bbody\b/gi, '.mf-root');
}

/**
 * A mail that scrolls inside itself sits inside the reading pane, which
 * already scrolls. Those boxes grow with their text instead.
 */
function flattenMailScroll(css: string): string {
  return css.replace(/[^{}]+\{[^{}]*\}/g, (rule) => {
    if (!/overflow(?:-[xy])?\s*:\s*(?:auto|scroll)\b/i.test(rule)) return rule;
    return rule
      .replace(/overflow(-[xy])?\s*:\s*(?:auto|scroll)\b/gi, 'overflow$1:visible')
      .replace(/max-height\s*:\s*[^;]+;?/gi, '');
  });
}

function isBlank(html: string): boolean {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/gi, ' ')
    .trim();
  if (text) return false;
  return !/<(img|svg|table|video|hr|ul|ol|blockquote)\b/i.test(html);
}

function readAttr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag);
  return match ? match[2] : null;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function estimateBytes(src: string): number {
  const marker = src.indexOf('base64,');
  if (marker < 0) return 0;
  const payload = src.slice(marker + 7).replace(/\s/g, '');
  return Math.floor((payload.length * 3) / 4);
}
