import { serializeFragment } from './darkMail';

/**
 * The server holds back every remote address named in the CSS of a mail —
 * background pictures, `@import`, web fonts — the same way it holds back
 * remote `<img>`: fetching one tells the sender the message was opened.
 * In their place it leaves a `url()` that loads nothing and carries the
 * original address (`server/src/remoteCss.ts` writes the same marker).
 *
 * This puts the addresses back, once the reader has asked for remote content.
 */

/** Shared with the server. */
const REMOTE_MARK = 'about:invalid#mf-remote=';

// Quotes are optional: a style attribute that went through the CSSOM comes
// back with them.
const HELD_BACK = /url\(\s*(["']?)about:invalid#mf-remote=([A-Za-z0-9_.%-]*)\1\s*\)/g;

/** `null` unless the marker carries a plain web address. */
function addressOf(packed: string): string | null {
  try {
    const url = new URL(decodeURIComponent(packed));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function release(css: string): string {
  return css.replace(HELD_BACK, (held, _quote: string, packed: string) => {
    const href = addressOf(packed);
    if (!href) return held;
    // A serialized URL has no quote and no newline; a backslash can survive
    // in its query, and would otherwise start an escape.
    return `url("${href.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
  });
}

/**
 * Works on the parsed document rather than on the HTML text: an address in a
 * `style` attribute and the same address in a `<style>` sheet are not escaped
 * the same way, and `&` in a query string is where a text replace goes wrong.
 */
export function releaseRemoteCss(html: string): string {
  if (!html.includes(REMOTE_MARK)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const sheet of doc.querySelectorAll('style')) {
    const css = sheet.textContent ?? '';
    const next = release(css);
    if (next !== css) sheet.textContent = next;
  }

  for (const el of doc.querySelectorAll('[style]')) {
    const css = el.getAttribute('style') ?? '';
    const next = release(css);
    if (next !== css) el.setAttribute('style', next);
  }

  return serializeFragment(doc);
}
