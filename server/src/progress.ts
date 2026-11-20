import type { Request } from 'express';
import { emitAppEvent } from './events.js';

/**
 * Real progress of a long request, pushed on the event stream so the button
 * that started it can fill (client/src/lib/progress.ts).
 *
 * The client names its request with a random id in `X-Mailflow-Op`. Each call
 * reports a checkpoint: `at` is the share of the work actually done (0 to 1),
 * `next` where the current step will end. The client glides from `at` toward
 * `next` on its own estimate, and `eta` (ms), when the server can guess the
 * step's length (an upload of known size), sharpens that estimate.
 *
 * Nothing here can fail the request: without the header, or with a header
 * that is not a plain id, the reporter does nothing.
 */
export type ProgressReporter = (at: number, next: number, eta?: number) => void;

const OP_ID = /^[A-Za-z0-9-]{8,64}$/;
/** Inside a step, at most one event per interval; a new step always goes out. */
const MIN_INTERVAL_MS = 80;

export const noProgress: ProgressReporter = () => undefined;

export function progressFor(req: Request): ProgressReporter {
  const op = req.get('x-mailflow-op');
  if (!op || !OP_ID.test(op)) return noProgress;

  let lastAt = -1;
  let lastNext = -1;
  let lastSent = 0;

  return (at, next, eta) => {
    const clampedAt = Math.min(1, Math.max(0, at));
    const clampedNext = Math.min(1, Math.max(clampedAt, next));
    // Never step back: a late event would make the button drain.
    if (clampedAt < lastAt) return;
    const now = Date.now();
    const newStep = clampedNext !== lastNext;
    if (!newStep && now - lastSent < MIN_INTERVAL_MS) return;
    lastAt = clampedAt;
    lastNext = clampedNext;
    lastSent = now;
    emitAppEvent({
      type: 'progress',
      account: '',
      op,
      progress: { at: clampedAt, next: clampedNext, ...(eta ? { eta: Math.round(eta) } : {}) },
    });
  };
}
