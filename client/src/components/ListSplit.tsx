/**
 * The bar between the message list and the reading pane.
 *
 * Dragging it left or right changes the list width; the choice is kept in
 * localStorage. With nothing stored, the list keeps its theme width (`w-96`,
 * which follows Classique's tighter spacing). Double-click returns to that
 * width. Arrow keys nudge it while the bar is focused.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useAppearance } from '../lib/theme';
import { cn } from '../lib/utils';

const STORAGE_KEY = 'mailflow.list-width';

/** Below this the rows stop showing a sender and a date, when the window allows it. */
const LIST_MIN = 220;
/** The reading pane stays usable: subject, toolbar, a few words of body. */
const READER_MIN = 240;
const KEY_STEP = 24;
const KEY_STEP_LARGE = 80;

function readStoredListWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null || raw === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 80 || value > 4000) return null;
    return Math.round(value);
  } catch {
    return null;
  }
}

function writeStoredListWidth(value: number | null): void {
  try {
    if (value == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* private browsing: the choice lasts as long as the tab */
  }
}

/** Space from the list's left edge to the end of the panes, minus the bar. */
function roomFor(list: HTMLElement, panes: HTMLElement): number {
  const split = list.nextElementSibling;
  const splitWidth = split instanceof HTMLElement ? split.offsetWidth : 0;
  return Math.floor(
    panes.getBoundingClientRect().right - list.getBoundingClientRect().left - splitWidth,
  );
}

function clampListWidth(list: HTMLElement, panes: HTMLElement, next: number): number {
  const room = roomFor(list, panes);
  if (room < 80) return Math.round(next);
  const max = Math.max(140, room - READER_MIN);
  const min = Math.min(LIST_MIN, max);
  return Math.round(Math.min(Math.max(next, min), max));
}

export function useMessageListWidth() {
  const listNode = useRef<HTMLDivElement>(null);
  const panesNode = useRef<HTMLDivElement>(null);
  const preferred = useRef<number | null>(readStoredListWidth());
  const dragCleanup = useRef<(() => void) | null>(null);
  const [width, setWidth] = useState<number | null>(preferred.current);
  const [dragging, setDragging] = useState(false);
  const [limits, setLimits] = useState({ now: 0, min: LIST_MIN, max: LIST_MIN });
  const { theme } = useAppearance();

  const publish = useCallback(() => {
    const list = listNode.current;
    const panes = panesNode.current;
    if (!list || !panes) return;
    const now = Math.round(list.getBoundingClientRect().width);
    const min = clampListWidth(list, panes, 0);
    const max = clampListWidth(list, panes, 1_000_000);
    setLimits((current) =>
      current.now === now && current.min === min && current.max === max
        ? current
        : { now, min, max },
    );
  }, []);

  const fit = useCallback(() => {
    const chosen = preferred.current;
    if (chosen == null) return;
    const list = listNode.current;
    const panes = panesNode.current;
    if (!list || !panes) return;
    if (roomFor(list, panes) < 80) return;
    const next = clampListWidth(list, panes, chosen);
    setWidth((current) => (current === next ? current : next));
  }, []);

  useLayoutEffect(() => {
    fit();
    publish();
  }, [width, theme, fit, publish]);

  useEffect(() => {
    function onResize() {
      fit();
    }
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      dragCleanup.current?.();
    };
  }, [fit]);

  const reset = useCallback(() => {
    preferred.current = null;
    writeStoredListWidth(null);
    setWidth(null);
  }, []);

  const commit = useCallback((next: number) => {
    const list = listNode.current;
    const panes = panesNode.current;
    if (!list || !panes) return;
    const clamped = clampListWidth(list, panes, next);
    preferred.current = clamped;
    writeStoredListWidth(clamped);
    setWidth(clamped);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const list = listNode.current;
    const panes = panesNode.current;
    if (!list || !panes) return;
    event.preventDefault();
    event.currentTarget.focus();

    const startW = list.getBoundingClientRect().width;
    const drag = { startX: event.clientX, latest: startW, frame: 0 };
    const root = document.documentElement;
    root.style.cursor = 'col-resize';
    root.style.userSelect = 'none';
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      drag.latest = startW + ev.clientX - drag.startX;
      if (drag.frame) return;
      drag.frame = requestAnimationFrame(() => {
        drag.frame = 0;
        const currentList = listNode.current;
        const currentPanes = panesNode.current;
        if (!currentList || !currentPanes) return;
        const next = clampListWidth(currentList, currentPanes, drag.latest);
        preferred.current = next;
        setWidth(next);
      });
    };

    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      if (dragCleanup.current === end) dragCleanup.current = null;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      root.style.cursor = '';
      root.style.userSelect = '';
      setDragging(false);
      const currentList = listNode.current;
      const currentPanes = panesNode.current;
      if (!currentList || !currentPanes) return;
      const next = clampListWidth(currentList, currentPanes, drag.latest);
      preferred.current = next;
      writeStoredListWidth(next);
      setWidth(next);
    };

    dragCleanup.current = end;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* The pointer may already be gone. Window listeners still follow the drag. */
    }
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const list = listNode.current;
      const panes = panesNode.current;
      if (!list || !panes) return;
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      let target: number | null = null;
      switch (event.key) {
        case 'ArrowLeft':
          target = list.getBoundingClientRect().width - step;
          break;
        case 'ArrowRight':
          target = list.getBoundingClientRect().width + step;
          break;
        case 'Home':
          target = 0;
          break;
        case 'End':
          target = 1_000_000;
          break;
        default:
          return;
      }
      event.preventDefault();
      commit(target);
    },
    [commit],
  );

  const sync = useCallback(() => {
    if (!listNode.current || !panesNode.current) return;
    fit();
    publish();
  }, [fit, publish]);

  // The panes mount after the account list arrives. The effect above has
  // already run by then, so the first measurement happens from these refs.
  // Either node can attach first.
  const listRef = useCallback(
    (node: HTMLDivElement | null) => {
      listNode.current = node;
      sync();
    },
    [sync],
  );

  const panesRef = useCallback(
    (node: HTMLDivElement | null) => {
      panesNode.current = node;
      sync();
    },
    [sync],
  );

  return {
    listRef,
    panesRef,
    width,
    dragging,
    limits,
    reset,
    onPointerDown,
    onKeyDown,
  };
}

export default function ListSplit({
  dragging,
  limits,
  onPointerDown,
  onKeyDown,
  onReset,
}: {
  dragging: boolean;
  limits: { now: number; min: number; max: number };
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
}) {
  return (
    <div className="mf-split relative z-20 w-0 shrink-0">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Largeur de la liste des messages"
        aria-valuemin={limits.min}
        aria-valuemax={limits.max}
        {...(limits.now > 0 ? { 'aria-valuenow': limits.now } : {})}
        tabIndex={0}
        title="Glisser pour régler la largeur. Double-clic pour la largeur d'origine."
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={onReset}
        className="group absolute inset-y-0 left-1/2 w-3 -translate-x-1/2 cursor-col-resize touch-none focus-visible:outline-none"
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent opacity-0',
            'group-hover:opacity-100 group-focus-visible:opacity-100',
            dragging && 'opacity-100',
          )}
        />
      </div>
      {dragging && (
        <div className="fixed inset-0 z-30 cursor-col-resize" aria-hidden="true" />
      )}
    </div>
  );
}
