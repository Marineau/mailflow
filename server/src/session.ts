import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Session token of the packaged app.
 *
 * The API has no login: it trusts whoever reaches the loopback port, which is
 * every program of the machine and every page open in a browser. The packaged
 * app closes that: its main process draws a random token at each launch,
 * hands it to this server in `MAILFLOW_SESSION_TOKEN` and to its own window
 * as a cookie (`desktop/main.ts`). A request without that cookie is refused,
 * the interface's files included.
 *
 * Without the variable nothing is checked: `npm run dev` and the daily server
 * behave as before, and are only as private as the machine is.
 */

/** Same name in `desktop/main.ts`: rename both together. */
export const SESSION_COOKIE = 'mailflow_session';

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

const token = process.env.MAILFLOW_SESSION_TOKEN?.trim() ?? '';
const expected = token ? digest(token) : null;

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals !== -1 && part.slice(0, equals).trim() === name) {
      return part.slice(equals + 1).trim();
    }
  }
  return null;
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!expected) {
    next();
    return;
  }

  // The provider sends the consent back through the system browser, which
  // holds no cookie. That route checks its own secret: the `state` drawn when
  // the consent started, valid once and for ten minutes (oauth.ts).
  if (req.method === 'GET' && req.path === '/api/oauth/callback') {
    next();
    return;
  }

  const presented = cookieValue(req.headers.cookie, SESSION_COOKIE);
  // Digests have one length, whatever was sent: the comparison cannot throw,
  // and its duration says nothing about the token.
  if (presented && crypto.timingSafeEqual(digest(presented), expected)) {
    next();
    return;
  }

  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Session inconnue.' });
    return;
  }
  res
    .status(401)
    .type('text/plain; charset=utf-8')
    .send('mailFlow : cette adresse ne répond qu’à la fenêtre de l’application.');
}
