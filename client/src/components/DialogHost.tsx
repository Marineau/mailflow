import { useEffect, useId, useRef } from 'react';
import { AlertCircle, HelpCircle } from './icons';
import WindowControls from './WindowControls';
import { useDialogRequests, type DialogRequest } from '../lib/dialog';
import { useWindowDrag } from '../lib/useWindowDrag';
import { useManagedWindow } from '../lib/windows';
import { cn } from '../lib/utils';

/**
 * Draws the confirmations and messages asked for through `lib/dialog.ts`.
 * Mounted once, in `App`, inside the windows layer.
 *
 * Each request is a floating window like the composer: it can be dragged
 * aside and minimized to the taskbar while the app stays usable. It is
 * therefore not modal. A minimized question keeps waiting; the action that
 * asked it only goes ahead once it is answered.
 */
export default function DialogHost() {
  const requests = useDialogRequests();
  return (
    <>
      {requests.map((request, index) => (
        <RequestWindow key={request.id} request={request} cascade={index % 6} />
      ))}
    </>
  );
}

function RequestWindow({ request, cascade }: { request: DialogRequest; cascade: number }) {
  const windowId = `dialog-${request.id}`;
  const { minimized, layer, activate, minimize } = useManagedWindow(windowId, {
    label: request.title,
    icon: request.kind === 'alert' ? AlertCircle : HelpCircle,
  });
  const { panelRef, position, moving, handleProps } = useWindowDrag<HTMLDivElement>();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Enter should answer the question and, when the action cannot be
    // undone, answer no.
    (request.danger ? cancelButton : confirmButton).current?.focus();
    return () => {
      // Back to what was focused before, unless the focus has moved elsewhere.
      if (opener?.isConnected && document.activeElement === document.body) opener.focus();
    };
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={panelRef}
      id={`mf-window-${windowId}`}
      tabIndex={-1}
      role={request.kind === 'alert' ? 'alertdialog' : 'dialog'}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      style={{
        zIndex: layer,
        ...(position
          ? { left: position.x, top: position.y }
          : // Centred; several at once step down and right.
            { left: `calc(50% + ${2 * cascade}rem)`, top: `calc(50% + ${2 * cascade}rem)` }),
      }}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      onKeyDown={(event) => {
        // Escape is a no, as with the close button.
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        request.settle(false);
      }}
      className={cn(
        'mf-window pointer-events-auto fixed flex max-h-[calc(100dvh-2rem-var(--mf-taskbar-h,0px))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl outline-none',
        position ? undefined : '-translate-x-1/2 -translate-y-1/2',
        moving && 'select-none',
        minimized && 'hidden',
      )}
    >
      <div
        title="Glisser pour déplacer"
        {...handleProps}
        className="mf-window-title flex shrink-0 cursor-grab touch-none items-center gap-1 border-b border-line px-4 py-3 select-none active:cursor-grabbing"
      >
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium">
          {request.title}
        </h2>
        <WindowControls onMinimize={minimize} onClose={() => request.settle(false)} />
      </div>

      <div className="mf-window-body flex min-h-0 flex-col">
        <p
          id={messageId}
          className="min-h-0 overflow-y-auto p-4 text-sm leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]"
        >
          {request.message}
        </p>

        <div className="mf-window-foot flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
          {request.kind === 'confirm' && (
            <button
              ref={cancelButton}
              type="button"
              onClick={() => request.settle(false)}
              className="mf-btn cursor-pointer rounded-md border border-line px-4 py-1.5 text-sm hover:bg-surface-hover"
            >
              {request.cancelLabel}
            </button>
          )}
          <button
            ref={confirmButton}
            type="button"
            onClick={() => request.settle(true)}
            className="mf-btn-primary cursor-pointer rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent transition-opacity hover:opacity-90"
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
