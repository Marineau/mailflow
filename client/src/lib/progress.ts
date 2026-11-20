/**
 * Progress of a long action, drawn as a fill inside the button that started
 * it (components/ProgressFill.tsx).
 *
 * Two levels, blended:
 *   1. Real checkpoints. The server reports them on the event stream for the
 *      request named by `X-Mailflow-Op` (server/src/progress.ts); the client
 *      reports its own (files read before a send, indexing events). A
 *      checkpoint says how much is done (`at`) and where the current step ends
 *      (`next`).
 *   2. An estimate inside the current step, so the fill keeps moving between
 *      checkpoints. Its pace comes, in order of trust, from the step's own
 *      expected length when the server knows it (`eta`), from the speed
 *      observed so far in this run, then from how long this kind of action
 *      took in past runs. It slows down as it nears the end of the step and
 *      never crosses it: only a real checkpoint moves the fill further.
 */

export type ProgressKind = 'refresh' | 'search' | 'send' | 'import' | 'account' | 'index';

export interface Checkpoint {
  at: number;
  next: number;
  /** Expected length of the current step, in ms, when known. */
  eta?: number;
  /** When it arrived (performance.now()). */
  t: number;
}

const checkpoints = new Map<string, Checkpoint>();

/** Header carrying the operation id to the server. */
export const OP_HEADER = 'X-Mailflow-Op';

export function newOpId(): string {
  return crypto.randomUUID();
}

export function reportProgress(op: string, at: number, next: number, eta?: number) {
  const clampedAt = Math.min(1, Math.max(0, at));
  const clampedNext = Math.min(1, Math.max(clampedAt, next));
  const previous = checkpoints.get(op);
  // A late event never makes the fill drain.
  if (previous && clampedAt < previous.at) return;
  checkpoints.set(op, { at: clampedAt, next: clampedNext, eta, t: performance.now() });
}

export function readCheckpoint(op: string): Checkpoint | undefined {
  return checkpoints.get(op);
}

export function forgetProgress(op: string) {
  checkpoints.delete(op);
}

/** First guess for a kind never timed on this machine, in ms for the whole action. */
const DEFAULT_MS: Record<ProgressKind, number> = {
  refresh: 2500,
  search: 10_000,
  send: 4000,
  import: 2000,
  account: 5000,
  index: 30 * 60_000,
};

const HISTORY_KEY = 'mailflow.progress-ms';

function readHistory(): Partial<Record<ProgressKind, number>> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<ProgressKind, number>>) : {};
  } catch {
    return {};
  }
}

/** Typical length of a whole action of this kind. */
export function typicalDuration(kind: ProgressKind): number {
  const known = readHistory()[kind];
  return typeof known === 'number' && known > 0 ? known : DEFAULT_MS[kind];
}

/** Folds one finished run into the typical length (moving average). */
export function recordDuration(kind: ProgressKind, ms: number) {
  if (!(ms > 0) || kind === 'index') return;
  try {
    const history = readHistory();
    const previous = history[kind];
    history[kind] = typeof previous === 'number' ? previous * 0.7 + ms * 0.3 : ms;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* storage unavailable: the defaults stay */
  }
}

/**
 * Where the fill should be now. `origin` is the first point of the run the
 * pace is measured from: the start at 0, or, for a job already under way when
 * the button appeared, its first checkpoint.
 */
export function estimate(
  checkpoint: Checkpoint,
  origin: { at: number; t: number },
  kind: ProgressKind,
  now: number,
): number {
  const span = checkpoint.next - checkpoint.at;
  if (span <= 0) return checkpoint.at;

  let stepMs: number;
  const progressed = checkpoint.at - origin.at;
  const took = checkpoint.t - origin.t;
  if (checkpoint.eta && checkpoint.eta > 0) {
    stepMs = checkpoint.eta;
  } else if (progressed > 0.02 && took > 50) {
    stepMs = (span * took) / progressed;
  } else {
    stepMs = span * typicalDuration(kind);
  }

  // 80 % of the step at its expected end, never more than 95 % of it.
  const elapsed = Math.max(0, now - checkpoint.t);
  const k = 1 - Math.exp((-1.6 * elapsed) / Math.max(stepMs, 1));
  return checkpoint.at + span * 0.95 * k;
}
