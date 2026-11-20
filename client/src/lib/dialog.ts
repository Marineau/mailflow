/**
 * In-app replacement for the browser's `confirm()` and `alert()`. Those are
 * drawn by the browser, so no theme reaches them; these are drawn by
 * `components/DialogHost.tsx` with the same `.mf-window` hooks as every other
 * window of the app.
 *
 * The calls stay imperative, like the ones they replace:
 *
 *   if (await confirmDialog({ title, message, confirmLabel })) …
 *
 * Each pending request is a window of its own (floating, draggable,
 * minimizable, see lib/windows.ts): a second question does not wait for the
 * first to be answered, and a minimized one keeps waiting on the taskbar.
 */
import { useSyncExternalStore } from 'react';

export interface DialogRequest {
  id: number;
  kind: 'confirm' | 'alert';
  title: string;
  /** Plain text. A blank line separates two paragraphs. */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Cannot be undone: the dialog opens with the focus on Cancel. */
  danger: boolean;
  settle: (confirmed: boolean) => void;
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface AlertOptions {
  title: string;
  message: string;
}

let queue: DialogRequest[] = [];
let sequence = 0;
const listeners = new Set<() => void>();

function push(request: Omit<DialogRequest, 'id' | 'settle'>): Promise<boolean> {
  return new Promise((resolve) => {
    sequence += 1;
    const id = sequence;
    queue = [
      ...queue,
      {
        ...request,
        id,
        settle(confirmed) {
          // A request leaves the queue once. A second answer is ignored.
          if (!queue.some((item) => item.id === id)) return;
          queue = queue.filter((item) => item.id !== id);
          for (const listener of listeners) listener();
          resolve(confirmed);
        },
      },
    ];
    for (const listener of listeners) listener();
  });
}

/** Resolves to true when the user confirms, false on Cancel, Escape or the close button. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return push({
    kind: 'confirm',
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel ?? 'OK',
    cancelLabel: options.cancelLabel ?? 'Annuler',
    danger: options.danger ?? false,
  });
}

/** Resolves once the message is dismissed. */
export async function alertDialog(options: AlertOptions): Promise<void> {
  await push({
    kind: 'alert',
    title: options.title,
    message: options.message,
    confirmLabel: 'OK',
    cancelLabel: '',
    danger: false,
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every request waiting for an answer, oldest first. */
export function useDialogRequests(): readonly DialogRequest[] {
  return useSyncExternalStore(subscribe, () => queue);
}
