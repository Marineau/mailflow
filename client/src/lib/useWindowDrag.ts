/**
 * Dragging a floating window by its title bar, and resizing one by its edges.
 *
 * The window keeps its CSS placement (a corner, the centre) until the first
 * drag or resize; from then on it is placed by `left` / `top`. A resize also
 * sets an explicit width and height. The opposite edge stays put: pulling the
 * bottom-right corner never moves the top-left. Pointer capture is not enough
 * on its own once the pointer leaves a thin edge, so a resize listens on the
 * window until the button comes up.
 *
 * Buttons in the title bar (minimize, close) carry `data-window-control`:
 * pressing one never starts a drag.
 */
import { useEffect, useRef, useState } from 'react';

const MARGIN = 24;

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

/** Edge or corner a resize gesture holds onto. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Box extends WindowPosition, WindowSize {}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface ResizeLimits {
  minWidth: number;
  minHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function placeInView(x: number, y: number, width: number, height: number): WindowPosition {
  const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  return {
    x: Math.min(Math.max(MARGIN, x), maxX),
    y: Math.min(Math.max(MARGIN, y), maxY),
  };
}

/** `--mf-taskbar-h` is inherited from `.mf-app` while the bar is showing. */
function taskbarHeight(panel: HTMLElement): number {
  const raw = getComputedStyle(panel).getPropertyValue('--mf-taskbar-h').trim();
  const value = Number.parseFloat(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) return 0;
  if (raw.endsWith('rem') || raw.endsWith('em')) {
    const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return value * (Number.isFinite(root) ? root : 16);
  }
  return value;
}

function readBounds(panel: HTMLElement): Bounds {
  const taskbar = taskbarHeight(panel);
  let minX = MARGIN;
  let minY = MARGIN;
  let maxX = window.innerWidth - MARGIN;
  let maxY = window.innerHeight - MARGIN - taskbar;
  if (maxX - minX < 160) {
    minX = 0;
    maxX = window.innerWidth;
  }
  if (maxY - minY < 120) {
    minY = 0;
    maxY = Math.max(0, window.innerHeight - taskbar);
  }
  return { minX, minY, maxX, maxY };
}

function roomLimits(bounds: Bounds, limits: ResizeLimits): { minW: number; minH: number; roomW: number; roomH: number } {
  const roomW = Math.max(0, bounds.maxX - bounds.minX);
  const roomH = Math.max(0, bounds.maxY - bounds.minY);
  return {
    roomW,
    roomH,
    minW: Math.min(limits.minWidth, roomW),
    minH: Math.min(limits.minHeight, roomH),
  };
}

/**
 * New box after dragging `edge` by `(dx, dy)` from `start`. The edges that
 * are not held stay where they were. The box stays inside `bounds` and never
 * shrinks below the limits, unless the viewport itself is smaller.
 */
export function resizeBox(
  start: Box,
  dx: number,
  dy: number,
  edge: ResizeEdge,
  bounds: Bounds,
  limits: ResizeLimits,
): Box {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const { minW, minH } = roomLimits(bounds, limits);
  // A window already narrower than the floor (a short viewport) must not jump
  // up to that floor on the first pixel of a resize.
  const floorW = Math.min(minW, start.width);
  const floorH = Math.min(minH, start.height);
  const holdW = edge === 'w' || edge === 'nw' || edge === 'sw';
  const holdE = edge === 'e' || edge === 'ne' || edge === 'se';
  const holdN = edge === 'n' || edge === 'ne' || edge === 'nw';
  const holdS = edge === 's' || edge === 'se' || edge === 'sw';

  let width = start.width;
  let height = start.height;
  if (holdE) width = start.width + dx;
  if (holdW) width = start.width - dx;
  if (holdS) height = start.height + dy;
  if (holdN) height = start.height - dy;

  if (holdE) width = clamp(width, floorW, Math.max(floorW, bounds.maxX - start.x));
  if (holdW) width = clamp(width, floorW, Math.max(floorW, right - bounds.minX));
  if (holdS) height = clamp(height, floorH, Math.max(floorH, bounds.maxY - start.y));
  if (holdN) height = clamp(height, floorH, Math.max(floorH, bottom - bounds.minY));

  return {
    x: holdW ? right - width : start.x,
    y: holdN ? bottom - height : start.y,
    width,
    height,
  };
}

/** Keep a resized window inside the viewport when the browser window changes. */
export function fitBox(box: Box, bounds: Bounds, limits: ResizeLimits): Box {
  const { minW, minH, roomW, roomH } = roomLimits(bounds, limits);
  const width = clamp(box.width, minW, Math.max(minW, roomW));
  const height = clamp(box.height, minH, Math.max(minH, roomH));
  return {
    width,
    height,
    x: clamp(box.x, bounds.minX, Math.max(bounds.minX, bounds.maxX - width)),
    y: clamp(box.y, bounds.minY, Math.max(bounds.minY, bounds.maxY - height)),
  };
}

function cursorFor(edge: ResizeEdge): string {
  switch (edge) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    default:
      return 'nwse-resize';
  }
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 48;

export function useWindowDrag<T extends HTMLElement>(limits?: Partial<ResizeLimits>) {
  const panelRef = useRef<T>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const endResizeRef = useRef<(() => void) | null>(null);
  const positionRef = useRef<WindowPosition | null>(null);
  const sizeRef = useRef<WindowSize | null>(null);
  const limitsRef = useRef<ResizeLimits>({ minWidth: 416, minHeight: 448 });
  limitsRef.current = {
    minWidth: limits?.minWidth ?? 416,
    minHeight: limits?.minHeight ?? 448,
  };

  const [position, setPosition] = useState<WindowPosition | null>(null);
  const [size, setSize] = useState<WindowSize | null>(null);
  const [moving, setMoving] = useState(false);
  const [resizing, setResizing] = useState(false);

  function commitPosition(next: WindowPosition) {
    positionRef.current = next;
    setPosition(next);
  }

  function commitBox(next: Box) {
    positionRef.current = { x: next.x, y: next.y };
    sizeRef.current = { width: next.width, height: next.height };
    setPosition(positionRef.current);
    setSize(sizeRef.current);
  }

  // A window already moved stays whole in view when the browser shrinks.
  // A window already resized shrinks with it, and stays above the taskbar.
  useEffect(() => {
    function onViewportResize() {
      const panel = panelRef.current;
      const placed = positionRef.current;
      if (!panel || !placed) return;
      const sized = sizeRef.current;
      if (sized) {
        const next = fitBox(
          { x: placed.x, y: placed.y, width: sized.width, height: sized.height },
          readBounds(panel),
          limitsRef.current,
        );
        if (next.x === placed.x && next.y === placed.y && next.width === sized.width && next.height === sized.height) {
          return;
        }
        positionRef.current = { x: next.x, y: next.y };
        sizeRef.current = { width: next.width, height: next.height };
        setPosition(positionRef.current);
        setSize(sizeRef.current);
        return;
      }
      const next = placeInView(placed.x, placed.y, panel.offsetWidth, panel.offsetHeight);
      if (next.x === placed.x && next.y === placed.y) return;
      positionRef.current = next;
      setPosition(next);
    }
    window.addEventListener('resize', onViewportResize);
    return () => {
      window.removeEventListener('resize', onViewportResize);
      endResizeRef.current?.();
    };
  }, []);

  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-window-control]')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer already released must not cancel the move.
    }
    commitPosition({ x: rect.left, y: rect.top });
    setMoving(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    commitPosition(
      placeInView(
        event.clientX - drag.offsetX,
        event.clientY - drag.offsetY,
        panel.offsetWidth,
        panel.offsetHeight,
      ),
    );
  }

  function onPointerEnd(event: React.PointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    onPointerMove(event);
    dragRef.current = null;
    setMoving(false);
  }

  function applyResize(edge: ResizeEdge, dx: number, dy: number) {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    commitBox(
      resizeBox(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        dx,
        dy,
        edge,
        readBounds(panel),
        limitsRef.current,
      ),
    );
  }

  function onResizePointerDown(edge: ResizeEdge, event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const start: Box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    const originX = event.clientX;
    const originY = event.clientY;
    // Leave the CSS corner anchor before the first move, at the same place.
    commitBox(start);

    const root = document.documentElement;
    root.style.cursor = cursorFor(edge);
    root.style.userSelect = 'none';
    setResizing(true);

    const onMove = (ev: PointerEvent) => {
      const current = panelRef.current;
      if (!current) return;
      commitBox(
        resizeBox(start, ev.clientX - originX, ev.clientY - originY, edge, readBounds(current), limitsRef.current),
      );
    };

    const end = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      if (endResizeRef.current === end) endResizeRef.current = null;
      root.style.cursor = '';
      root.style.userSelect = '';
      setResizing(false);
    };

    endResizeRef.current = end;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners still follow the gesture if capture is refused.
    }
  }

  function onResizeKeyDown(edge: ResizeEdge, event: React.KeyboardEvent<HTMLElement>) {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case 'ArrowLeft':
        dx = -step;
        break;
      case 'ArrowRight':
        dx = step;
        break;
      case 'ArrowUp':
        dy = -step;
        break;
      case 'ArrowDown':
        dy = step;
        break;
      default:
        return;
    }
    event.preventDefault();
    applyResize(edge, dx, dy);
  }

  return {
    panelRef,
    /** `null` until the first drag or resize: the window keeps its CSS placement. */
    position,
    /** `null` until the first resize: the window keeps its CSS size. */
    size,
    moving,
    resizing,
    /** Spread on the title bar. */
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
    onResizePointerDown,
    onResizeKeyDown,
  };
}
