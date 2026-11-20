import sanitizeHtml from 'sanitize-html';

const MAX_HTML_CHARS = 1_000_000;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Font names and stacks only: no parentheses, so no `url()` or `expression()`. */
const FONT_FAMILY = /^[a-z0-9 ,'"-]{1,120}$/i;
const FONT_SIZE = /^(?:[89]|[1-6]\d|7[0-2])px$/;

/**
 * HTML we send is produced by the composer, but the request is still untrusted.
 * What survives is what mail clients render reliably: text marks, a styled span
 * (color, highlight, font, size), web and mail links, and cid images that belong
 * to an attached screenshot.
 */
export function sanitizeOutgoingHtml(html: string, cids: ReadonlySet<string>): string | undefined {
  if (html.length > MAX_HTML_CHARS) {
    throw Object.assign(new Error('Le message est trop long'), { status: 400 });
  }

  const clean = sanitizeHtml(html, {
    allowedTags: ['div', 'p', 'br', 'img', 'strong', 'b', 'em', 'i', 'u', 's', 'span', 'a'],
    allowedAttributes: { img: ['src', 'alt'], span: ['style'], a: ['href'] },
    allowedStyles: {
      span: {
        color: [HEX_COLOR],
        'background-color': [HEX_COLOR],
        'font-family': [FONT_FAMILY],
        'font-size': [FONT_SIZE],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowedSchemesByTag: { img: ['cid'], a: ['http', 'https', 'mailto'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    exclusiveFilter: (frame) => {
      if (frame.tag !== 'img') return false;
      const src = frame.attribs.src ?? '';
      const cid = src.startsWith('cid:') ? src.slice(4) : '';
      return !cids.has(cid);
    },
  }).trim();

  if (!clean) return undefined;
  const hasImage = /<img\b/i.test(clean);
  const text = clean
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  if (!hasImage && !text) return undefined;
  return clean;
}
