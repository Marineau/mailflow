import type { ReactNode } from 'react';
import { useBusyCursor } from '../lib/busyCursor';
import { cn } from '../lib/utils';

const LIST_ROWS = [
  { from: 'w-28', subject: 'w-[70%]', snippet: 'w-[46%]' },
  { from: 'w-40', subject: 'w-[86%]', snippet: 'w-[58%]' },
  { from: 'w-24', subject: 'w-[62%]', snippet: 'w-[40%]' },
  { from: 'w-36', subject: 'w-[78%]', snippet: 'w-[52%]' },
  { from: 'w-32', subject: 'w-[66%]', snippet: 'w-[44%]' },
] as const;

const FOLDER_WIDTHS = ['w-24', 'w-32', 'w-20', 'w-28', 'w-16', 'w-36'] as const;

const BODY_LINES = [
  'w-full',
  'w-full',
  'w-11/12',
  'w-4/5',
  'mt-4 w-full',
  'w-full',
  'w-3/4',
  'mt-4 w-full',
  'w-5/6',
  'w-2/3',
] as const;

/** Thin accent bar pinned to the top of a column while a fetch is in flight. */
export function SyncBar() {
  useBusyCursor();
  return (
    <div className="mf-indet-track sticky top-0 z-10" role="presentation">
      <div className="mf-indet-bar" />
    </div>
  );
}

function Sweep({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  useBusyCursor();
  return (
    <div className={cn('mf-sweep', className)} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="mf-sweep-light" aria-hidden="true" />
      {children}
    </div>
  );
}

function Bone({ className }: { className?: string }) {
  return <span className={cn('mf-bone', className)} aria-hidden="true" />;
}

/** Placeholder rows for the message column — first load, folder change, search. */
export function MessageListSkeleton({
  rows = 14,
  label = 'Chargement des messages',
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <Sweep label={label}>
      {Array.from({ length: rows }, (_, index) => {
        const shape = LIST_ROWS[index % LIST_ROWS.length];
        return (
          <div key={index} className="flex flex-col gap-2 border-b border-line px-4 py-3.5">
            <div className="flex items-center gap-3">
              <Bone className={cn('h-3.5', shape.from)} />
              <Bone className="ml-auto h-3 w-10" />
            </div>
            <Bone className={cn('h-3.5', shape.subject)} />
            <Bone className={cn('h-3', shape.snippet)} />
          </div>
        );
      })}
    </Sweep>
  );
}

/** Placeholder rows for the folder column — first load and account switch. */
export function FolderListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Sweep label="Chargement des dossiers" className="flex flex-col gap-0.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2.5 px-3 py-2.5">
          <Bone className="size-4 shrink-0 rounded-sm" />
          <Bone className={cn('h-3.5', FOLDER_WIDTHS[index % FOLDER_WIDTHS.length])} />
        </div>
      ))}
    </Sweep>
  );
}

/**
 * Placeholder for the reading pane.
 * `withChrome` draws the header too — used before any message is selected.
 * Once a message is open, the real header stays and only the body waits.
 */
export function MessageBodySkeleton({
  label = 'Téléchargement du message',
  withChrome = false,
}: {
  label?: string;
  withChrome?: boolean;
}) {
  return (
    // With its own header it stands in for the whole reading pane, so it takes
    // the pane's hook; without, it already sits inside one.
    <Sweep
      label={label}
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', withChrome && 'mf-reader')}
    >
      {withChrome && (
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <Bone className="size-9 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
            <Bone className="h-4 w-1/2" />
            <Bone className="h-3 w-1/3" />
            <Bone className="h-3 w-2/5" />
          </div>
        </div>
      )}
      <div className={cn('flex flex-col gap-3', withChrome ? 'px-8 py-8' : 'px-8 py-7')}>
        {BODY_LINES.map((width, index) => (
          <Bone key={index} className={cn('h-3', width)} />
        ))}
      </div>
    </Sweep>
  );
}
