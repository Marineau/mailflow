import { readAttachmentFile, storeAttachmentBytes } from './attachments.js';

/**
 * Photos pasted into the HTML as data URIs (or left as cid:) are what makes a
 * message slow to open: ten JPEGs become several megabytes of base64, and the
 * text cannot paint until that payload is parsed. They are already compressed.
 * Re-encoding them would still ship every picture before the first line.
 *
 * Pictures larger than this stay out of the HTML. The client asks for them,
 * one click, through the attachment files already stored for that message.
 * Logos and spacers under the threshold stay inline so an ordinary mail does
 * not open with holes in it.
 */
const HEAVY_BYTES = 48 * 1024;

export interface InlineAttachment {
  filename: string;
  contentType: string;
  size: number;
  cid: string | null;
}

export function deferHeavyImages(
  html: string,
  accountId: string,
  folder: string,
  uid: number,
  attachments: InlineAttachment[],
): { html: string; inlineImages: number; attachments: InlineAttachment[] } {
  const next = attachments.map((item) => ({ ...item }));
  const byCid = new Map<string, number>();
  next.forEach((item, index) => {
    if (item.cid) byCid.set(normalizeCid(item.cid), index);
  });

  let inlineImages = html.match(/\sdata-file="/g)?.length ?? 0;

  const rewritten = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = readAttr(tag, 'src');
    if (!src) return tag;

    if (/^cid:/i.test(src)) {
      const index = byCid.get(normalizeCid(src));
      if (index === undefined) return tag;
      const item = next[index];
      if (!item || !isImage(item.contentType)) return tag;
      if (item.size > HEAVY_BYTES) {
        inlineImages += 1;
        return markDeferred(tag, index);
      }
      const bytes = readAttachmentFile(accountId, folder, uid, index);
      if (!bytes) return tag;
      if (bytes.length > HEAVY_BYTES) {
        inlineImages += 1;
        return markDeferred(tag, index);
      }
      const type = item.contentType || 'image/jpeg';
      return replaceAttr(tag, 'src', `data:${type};base64,${bytes.toString('base64')}`);
    }

    if (!/^data:image\//i.test(src)) return tag;
    const decoded = decodeDataImage(src);
    if (!decoded || decoded.bytes.length <= HEAVY_BYTES) return tag;

    const index = remember(decoded.bytes, decoded.type, readAttr(tag, 'alt') || 'image');
    inlineImages += 1;
    return markDeferred(tag, index);
  });

  return { html: rewritten, inlineImages, attachments: next };

  function remember(bytes: Buffer, contentType: string, filename: string): number {
    for (let index = 0; index < next.length; index += 1) {
      if (next[index].size !== bytes.length) continue;
      const stored = readAttachmentFile(accountId, folder, uid, index);
      if (stored && stored.length === bytes.length && stored.equals(bytes)) return index;
    }
    const index = next.length;
    next.push({
      filename,
      contentType,
      size: bytes.length,
      cid: null,
    });
    storeAttachmentBytes(accountId, folder, uid, [{ index, content: bytes }]);
    return index;
  }
}

function markDeferred(tag: string, index: number): string {
  const stripped = tag
    .replace(/\s+src\s*=\s*(["'])[\s\S]*?\1/i, '')
    .replace(/\s+data-file\s*=\s*(["'])[\s\S]*?\1/i, '');
  return stripped.replace(/<img\b/i, `<img data-file="${index}"`);
}

function replaceAttr(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s+${name}\\s*=\\s*(["'])[\\s\\S]*?\\1`, 'i');
  if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${value}"`);
  return tag.replace(/<img\b/i, `<img ${name}="${value}"`);
}

function readAttr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag);
  return match ? match[2] : null;
}

function decodeDataImage(src: string): { type: string; bytes: Buffer } | null {
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;charset=[^;,]+)?;base64,([a-z0-9+/=\r\n]+)$/i.exec(
    src,
  );
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (bytes.length === 0) return null;
  return { type: match[1].toLowerCase(), bytes };
}

function normalizeCid(value: string): string {
  let cid = value.trim();
  if (cid.toLowerCase().startsWith('cid:')) cid = cid.slice(4);
  if (cid.startsWith('<') && cid.endsWith('>')) cid = cid.slice(1, -1);
  try {
    cid = decodeURIComponent(cid);
  } catch {
    /* a cid is an opaque token; a broken escape stays as written */
  }
  return cid.toLowerCase();
}

function isImage(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/');
}
