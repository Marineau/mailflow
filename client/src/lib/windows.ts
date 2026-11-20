/**
 * The floating windows of the app (message composers, the theme picker,
 * the dialog boxes) and their two shared states: which one sits above which,
 * and which ones are minimized to the taskbar.
 *
 * A window joins with `useManagedWindow(id, meta)` while it is mounted. Its
 * element carries the id `mf-window-<id>`, so focus can be sent back into it
 * on restore. A minimized window stays mounted and is only hidden: whatever
 * it holds (a message being written, a question waiting for its answer)
 * survives.
 *
 * Stacking: every window is drawn inside one layer (`.mf-windows` in App),
 * and gets `z-index` from its rank in `order`, the last activated on top.
 */
import { useEffect, useSyncExternalStore, type ComponentType } from 'react';
import type { IconProps } from '../components/icons';

export interface WindowMeta {
  /** Name on the taskbar button. */
  label: string;
  icon: ComponentType<IconProps>;
}

interface State {
  /** Back to front. */
  order: string[];
  /** In the order they were minimized: the taskbar order. */
  minimized: string[];
  meta: Record<string, WindowMeta>;
}

let state: State = { order: [], minimized: [], meta: {} };
const listeners = new Set<() => void>();

function commit(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useWindowsState(): State {
  return useSyncExternalStore(subscribe, () => state);
}

function register(id: string, meta: WindowMeta): void {
  commit({
    order: [...state.order.filter((entry) => entry !== id), id],
    minimized: state.minimized,
    meta: { ...state.meta, [id]: meta },
  });
}

function unregister(id: string): void {
  if (!state.meta[id]) return;
  const meta = { ...state.meta };
  delete meta[id];
  commit({
    order: state.order.filter((entry) => entry !== id),
    minimized: state.minimized.filter((entry) => entry !== id),
    meta,
  });
}

function describe(id: string, meta: WindowMeta): void {
  const current = state.meta[id];
  if (!current || (current.label === meta.label && current.icon === meta.icon)) return;
  commit({ ...state, meta: { ...state.meta, [id]: meta } });
}

/** Puts a window above the others. */
export function activateWindow(id: string): void {
  if (state.order[state.order.length - 1] === id || !state.meta[id]) return;
  commit({ ...state, order: [...state.order.filter((entry) => entry !== id), id] });
}

/** Reduces a window to the taskbar and moves the focus to its button there. */
export function minimizeWindow(id: string): void {
  if (state.minimized.includes(id)) return;
  commit({ ...state, minimized: [...state.minimized, id] });
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>(`[data-taskbar-window='${id}']`)?.focus(),
  );
}

/** Brings a window back from the taskbar, above the others, with the focus in it. */
export function restoreWindow(id: string): void {
  commit({
    ...state,
    minimized: state.minimized.filter((entry) => entry !== id),
    order: [...state.order.filter((entry) => entry !== id), id],
  });
  requestAnimationFrame(() => document.getElementById(`mf-window-${id}`)?.focus());
}

/**
 * Joins the window manager for as long as the calling window is mounted.
 * The label can change while it is open (a composer names itself after its
 * subject): the taskbar follows.
 */
export function useManagedWindow(id: string, meta: WindowMeta) {
  const current = useWindowsState();

  useEffect(() => {
    register(id, meta);
    return () => unregister(id);
    // Registration is per id; label changes go through `describe` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    describe(id, meta);
  }, [id, meta.label, meta.icon]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    minimized: current.minimized.includes(id),
    /** Rank in the stack, for `z-index`: 1 at the back. */
    layer: current.order.indexOf(id) + 1,
    activate: () => activateWindow(id),
    minimize: () => minimizeWindow(id),
  };
}

/** The windows on the taskbar, in its order. */
export function useMinimizedWindows(): { id: string; meta: WindowMeta }[] {
  const current = useWindowsState();
  return current.minimized.flatMap((id) => {
    const meta = current.meta[id];
    return meta ? [{ id, meta }] : [];
  });
}
