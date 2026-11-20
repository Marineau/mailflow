/**
 * Remote references inside the CSS of a mail: `<style>` sheets and `style`
 * attributes. A background picture, an `@import` or a web font is fetched the
 * moment the message is drawn, which tells the sender it was opened — the
 * same tracker as a remote `<img>`, and it gets the same treatment.
 *
 * A remote reference is swapped for a `url()` that loads nothing and carries
 * the original address, so the client can put it back when the reader asks
 * for remote content (`client/src/lib/remoteCss.ts` reads the same marker).
 * The swap keeps the declaration valid: `background: #fff url(…)` keeps its
 * color while the picture is held back.
 *
 * The text is walked token by token rather than matched with a regular
 * expression, because CSS lets an author write `url` as `\75rl`, put the
 * address in a string after `@import`, or split it across escaped newlines.
 * Where this scanner and a browser could disagree, it reads a shorter name
 * than the browser would: the cost is a harmless extra swap, never a miss.
 */

/** Shared with the client. Changing it means bumping `SANITIZER_VERSION`. */
export const REMOTE_MARK = 'about:invalid#mf-remote=';

/** For a reference that is neither inline nor a plain web address: never restored. */
const DEAD_URL = 'url(about:invalid)';

/** An unknown function makes its declaration invalid; the browser drops it. */
const DEAD_FUNCTION = 'mf-blocked()';

/**
 * Functions that take an address as a bare string. Through a custom property
 * (`image-set(var(--x) 1x)`) the string can sit anywhere in the sheet, so the
 * whole function goes rather than its arguments.
 */
const STRING_ADDRESS_FUNCTION = /^(?:-[a-z]+-)?(?:image-set|image|src)$/;

type Verdict = { kind: 'keep' } | { kind: 'dead' } | { kind: 'remote'; href: string };

function isNewline(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r' || ch === '\f';
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || isNewline(ch);
}

function isHex(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
}

/** ASCII only: a browser also accepts non-ASCII letters, this scanner stops at them. */
function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z0-9_-]$/.test(ch);
}

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z_-]$/.test(ch);
}

/** A backslash starts an escape unless a newline follows it. */
function startsEscape(css: string, at: number): boolean {
  return css[at] === '\\' && !isNewline(css[at + 1]);
}

function readEscape(css: string, at: number): { value: string; end: number } {
  let next = at + 1;
  if (next >= css.length) return { value: '\uFFFD', end: next };

  if (isHex(css[next])) {
    let hex = '';
    while (hex.length < 6 && isHex(css[next])) {
      hex += css[next];
      next += 1;
    }
    // One whitespace after the digits belongs to the escape.
    if (css[next] === '\r' && css[next + 1] === '\n') next += 2;
    else if (isSpace(css[next])) next += 1;

    const code = parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return { value: valid ? String.fromCodePoint(code) : '\uFFFD', end: next };
  }

  const value = String.fromCodePoint(css.codePointAt(next) ?? 0xfffd);
  return { value, end: next + value.length };
}

function readName(css: string, at: number): { name: string; end: number } {
  let name = '';
  let next = at;
  for (;;) {
    if (isNameChar(css[next])) {
      name += css[next];
      next += 1;
    } else if (next < css.length && startsEscape(css, next)) {
      const escape = readEscape(css, next);
      name += escape.value;
      next = escape.end;
    } else {
      return { name, end: next };
    }
  }
}

/**
 * A string ends at its quote, at the end of the text — where it is still a
 * valid string — or at a bare newline, where it is `broken` and the browser
 * throws its declaration away.
 */
function readString(css: string, at: number): { value: string; end: number; broken: boolean } {
  const quote = css[at];
  let value = '';
  let next = at + 1;
  while (next < css.length) {
    const ch = css[next];
    if (ch === quote) return { value, end: next + 1, broken: false };
    if (isNewline(ch)) return { value, end: next, broken: true };
    if (ch === '\\') {
      if (next + 1 >= css.length) {
        next += 1;
      } else if (isNewline(css[next + 1])) {
        next += css[next + 1] === '\r' && css[next + 2] === '\n' ? 3 : 2;
      } else {
        const escape = readEscape(css, next);
        value += escape.value;
        next = escape.end;
      }
      continue;
    }
    value += ch;
    next += 1;
  }
  return { value, end: next, broken: false };
}

/** Index just past the `)` that closes a function opened before `from`. */
function closingParen(css: string, from: number): number {
  let depth = 1;
  let next = from;
  while (next < css.length) {
    const ch = css[next];
    if (ch === '"' || ch === "'") {
      next = readString(css, next).end;
      continue;
    }
    if (ch === '/' && css[next + 1] === '*') {
      const close = css.indexOf('*/', next + 2);
      next = close < 0 ? css.length : close + 2;
      continue;
    }
    if (ch === '\\') {
      next = startsEscape(css, next) ? readEscape(css, next).end : next + 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return next + 1;
    }
    next += 1;
  }
  return css.length;
}

/** The target of a `url(` opened just before `from`, and where the token ends. */
function readUrlTarget(css: string, from: number): { value: string; end: number; broken: boolean } {
  let next = from;
  while (isSpace(css[next])) next += 1;

  if (css[next] === '"' || css[next] === "'") {
    const string = readString(css, next);
    return { value: string.value, end: closingParen(css, string.end), broken: string.broken };
  }

  let value = '';
  while (next < css.length) {
    const ch = css[next];
    if (ch === ')') return { value, end: next + 1, broken: false };
    if (startsEscape(css, next)) {
      const escape = readEscape(css, next);
      value += escape.value;
      next = escape.end;
      continue;
    }
    value += ch;
    next += 1;
  }
  return { value, end: next, broken: false };
}

/**
 * What a reference points at. Only three things may stay: bytes carried by
 * the message (`data:`, `cid:`) and a fragment of the document itself. A web
 * address is held back and can be restored. Everything else — a relative
 * path, which would resolve against mailFlow's own origin, `file:`, a scheme
 * nobody asked for — is dropped for good.
 *
 * An `@import` is stricter: a `data:` stylesheet is CSS this scanner has not
 * read, and it could name remote addresses of its own.
 */
function judge(raw: string, isImport: boolean): Verdict {
  // What the URL parser does first: tabs and newlines vanish wherever they
  // are, then controls and spaces are trimmed at both ends.
  const target = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');

  if (!isImport && (target.startsWith('#') || /^(?:data|cid):/i.test(target))) {
    return { kind: 'keep' };
  }

  const web = /^https?:/i.test(target);
  const schemeRelative = /^[/\\]{2}/.test(target);
  if (!web && !schemeRelative) return { kind: 'dead' };

  try {
    // Parsed without a base: `http:pixel.gif` becomes an absolute address
    // here, where a browser would resolve it against the page.
    const url = new URL(schemeRelative ? `https:${target}` : target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'dead' };
    return { kind: 'remote', href: url.href };
  } catch {
    return { kind: 'dead' };
  }
}

/** The address, in characters that need no quoting inside `url()` nor inside an HTML attribute. */
function heldBack(href: string): string {
  const packed = encodeURIComponent(href).replace(
    /[!'()*~]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `url(${REMOTE_MARK}${packed})`;
}

/**
 * Holds back every remote reference of a stylesheet or of a `style`
 * attribute. `blocked` counts the ones the client is able to restore.
 */
export function neutralizeRemoteCss(css: string): { css: string; blocked: number } {
  let out = '';
  let copied = 0;
  let blocked = 0;
  let at = 0;
  // `@import` takes its address from the next token, string or `url()`.
  // `@namespace` names a namespace with the same syntax and fetches nothing:
  // rewriting it would detach every rule of the sheet from the document.
  let prelude: 'import' | 'namespace' | null = null;

  const swap = (start: number, end: number, replacement: string) => {
    out += css.slice(copied, start) + replacement;
    copied = end;
  };

  const settle = (start: number, end: number, verdict: Verdict) => {
    if (verdict.kind === 'keep') return;
    if (verdict.kind === 'remote') {
      blocked += 1;
      swap(start, end, heldBack(verdict.href));
    } else {
      swap(start, end, DEAD_URL);
    }
  };

  while (at < css.length) {
    const ch = css[at];

    if (ch === '/' && css[at + 1] === '*') {
      const close = css.indexOf('*/', at + 2);
      at = close < 0 ? css.length : close + 2;
      continue;
    }

    if (isSpace(ch)) {
      at += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const string = readString(css, at);
      if (prelude === 'import') {
        settle(at, string.end, string.broken ? { kind: 'dead' } : judge(string.value, true));
        prelude = null;
      }
      at = string.end;
      continue;
    }

    if (ch === '@' && (isNameStart(css[at + 1]) || startsEscape(css, at + 1))) {
      const keyword = readName(css, at + 1);
      const name = keyword.name.toLowerCase();
      prelude = name === 'import' ? 'import' : name === 'namespace' ? 'namespace' : null;
      at = keyword.end;
      continue;
    }

    if (isNameStart(ch) || startsEscape(css, at)) {
      const ident = readName(css, at);
      const name = ident.name.toLowerCase();
      const isImport = prelude === 'import';
      if (isImport) prelude = null;

      if (css[ident.end] !== '(') {
        at = ident.end;
        continue;
      }

      if (name === 'url') {
        const target = readUrlTarget(css, ident.end + 1);
        if (prelude !== 'namespace') {
          settle(at, target.end, target.broken ? { kind: 'dead' } : judge(target.value, isImport));
        }
        at = target.end;
        continue;
      }

      if (STRING_ADDRESS_FUNCTION.test(name)) {
        const end = closingParen(css, ident.end + 1);
        swap(at, end, DEAD_FUNCTION);
        at = end;
        continue;
      }

      at = ident.end + 1;
      continue;
    }

    // The end of a rule or of a declaration closes the prelude; any other
    // token after `@import` means its address is not coming.
    if (ch === ';' || ch === '{' || ch === '}') prelude = null;
    else if (prelude === 'import') prelude = null;
    at += 1;
  }

  if (copied === 0) return { css, blocked };
  return { css: out + css.slice(copied), blocked };
}
