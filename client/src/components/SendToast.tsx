import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Send, X } from './icons';
import { cn } from '../lib/utils';

/** What the composer reports. The id is assigned by the app so a new send replaces the previous toast. */
export type SendActivity =
  | { phase: 'sending'; recipients: string; subject: string }
  | {
      phase: 'sent';
      recipients: string;
      subject: string;
      accepted: string[];
      rejected: string[];
      copiedTo: string | null;
      /** `server` when the mailbox files the copy itself and Pli appends none. */
      copiedBy: 'mailflow' | 'server' | null;
      copyError: string | null;
    }
  | { phase: 'error'; message: string };

export type SendToastState = SendActivity & { id: number };

const SUCCESS_VISIBLE_MS = 5200;

interface Props {
  state: SendToastState;
  onDismiss: () => void;
}

export default function SendToast({ state, onDismiss }: Props) {
  const [progress, setProgress] = useState(state.phase === 'sending' ? 8 : 100);
  const [hovered, setHovered] = useState(false);
  const sending = state.phase === 'sending';
  const sent = state.phase === 'sent';
  const failed = state.phase === 'error';

  useEffect(() => {
    if (state.phase !== 'sending') {
      setProgress(100);
      return;
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setProgress(42);
      return;
    }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const seconds = (now - started) / 1000;
      // SMTP gives no byte progress. Creep toward 90% until the response arrives.
      setProgress(8 + 82 * (1 - Math.exp(-seconds / 5)));
      frame = requestAnimationFrame(tick);
    };
    setProgress(8);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state.id, state.phase]);

  useEffect(() => {
    if (state.phase !== 'sent' || hovered) return;
    const timer = window.setTimeout(onDismiss, SUCCESS_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [state.id, state.phase, hovered, onDismiss]);

  const title = sending ? 'Envoi en cours' : sent ? 'Message envoyé' : 'Envoi impossible';

  return createPortal(
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="mf-toast fixed top-[4.75rem] left-1/2 z-50 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-2xl"
    >
      <div
        className="mf-progress h-1 overflow-hidden bg-line"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        aria-label={title}
      >
        <div
          data-state={failed ? 'error' : undefined}
          className={cn(
            'mf-progress-fill h-full',
            failed ? 'bg-warn' : 'bg-accent',
            !sending && 'transition-[width] duration-300 ease-out',
          )}
          style={{ width: `${Math.min(100, progress)}%` }}
        />
      </div>
      <div
        role={failed ? 'alert' : 'status'}
        aria-live={failed ? 'assertive' : 'polite'}
        aria-atomic="true"
        aria-busy={sending}
        className="flex items-start gap-3 px-3.5 py-3"
      >
        <span
          className={cn(
            'mf-toast-icon mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
            failed && 'bg-warn/15 text-warn',
            sent && 'bg-accent/15 text-accent',
            sending && 'bg-surface-hover text-ink-muted',
          )}
        >
          {failed ? (
            <AlertCircle className="size-4" aria-hidden="true" />
          ) : sent ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Send className="size-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{title}</p>
          <ToastDetail state={state} />
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Fermer"
          className="mf-icon-btn rounded-md p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

function ToastDetail({ state }: { state: SendToastState }) {
  if (state.phase === 'error') {
    return <p className="mt-0.5 line-clamp-4 text-sm text-ink-muted">{state.message}</p>;
  }

  if (state.phase === 'sending') {
    return (
      <div className="mt-0.5 min-w-0 text-sm text-ink-muted">
        <p className="truncate">À {state.recipients}</p>
        {state.subject.trim() !== '' && <p className="truncate">{state.subject.trim()}</p>}
      </div>
    );
  }

  const delivered = state.accepted.length > 0 ? joinList(state.accepted) : state.recipients;
  return (
    <div className="mt-0.5 min-w-0 space-y-0.5 text-sm text-ink-muted">
      <p className="truncate">À {delivered}</p>
      {state.subject.trim() !== '' && <p className="truncate">{state.subject.trim()}</p>}
      {state.rejected.length > 0 && (
        <p className="line-clamp-2 text-warn">Refusé : {joinList(state.rejected)}</p>
      )}
      <CopyLine copiedTo={state.copiedTo} copiedBy={state.copiedBy} copyError={state.copyError} />
    </div>
  );
}

function CopyLine({
  copiedTo,
  copiedBy,
  copyError,
}: {
  copiedTo: string | null;
  copiedBy: 'mailflow' | 'server' | null;
  copyError: string | null;
}) {
  if (copiedBy === 'server') {
    return (
      <p className="truncate">
        Copie rangée par le serveur dans {copiedTo ? folderLeaf(copiedTo) : 'Envoyés'}
      </p>
    );
  }
  if (copiedTo) return <p className="truncate">Copié dans {folderLeaf(copiedTo)}</p>;
  if (copyError) {
    return <p className="line-clamp-2 text-warn">Copie dans Envoyés impossible — {copyError}</p>;
  }
  return <p className="truncate">Dossier Envoyés introuvable</p>;
}

function joinList(items: string[], max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max}`;
}

function folderLeaf(path: string): string {
  const parts = path.split(/[/\\.]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
