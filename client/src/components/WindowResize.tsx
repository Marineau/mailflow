import type { ResizeEdge } from '../lib/useWindowDrag';
import { cn } from '../lib/utils';

/**
 * Hit targets on the edges and corners of a floating window. The window
 * clips them (`overflow: hidden`), so they sit inside the frame rather than
 * outside it. Only the bottom-right corner is in the tab order: the other
 * edges are pointer targets, and that corner is the one a keyboard can grow
 * or shrink.
 */
const EDGES: { edge: ResizeEdge; label: string; cursor: string; className: string }[] = [
  { edge: 'n', label: 'Redimensionner par le haut', cursor: 'cursor-ns-resize', className: 'inset-x-3 top-0 h-2' },
  { edge: 's', label: 'Redimensionner par le bas', cursor: 'cursor-ns-resize', className: 'inset-x-3 bottom-0 h-2' },
  { edge: 'w', label: 'Redimensionner par la gauche', cursor: 'cursor-ew-resize', className: 'inset-y-3 left-0 w-2' },
  { edge: 'e', label: 'Redimensionner par la droite', cursor: 'cursor-ew-resize', className: 'inset-y-3 right-0 w-2' },
  {
    edge: 'nw',
    label: 'Redimensionner par le coin supérieur gauche',
    cursor: 'cursor-nwse-resize',
    className: 'top-0 left-0 z-10 size-3',
  },
  {
    edge: 'ne',
    label: 'Redimensionner par le coin supérieur droit',
    cursor: 'cursor-nesw-resize',
    className: 'top-0 right-0 z-10 size-3',
  },
  {
    edge: 'sw',
    label: 'Redimensionner par le coin inférieur gauche',
    cursor: 'cursor-nesw-resize',
    className: 'bottom-0 left-0 z-10 size-3',
  },
  {
    edge: 'se',
    label: 'Redimensionner par le coin inférieur droit',
    cursor: 'cursor-nwse-resize',
    className: 'bottom-0 right-0 z-10 size-3',
  },
];

interface Props {
  onPointerDown: (edge: ResizeEdge, event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (edge: ResizeEdge, event: React.KeyboardEvent<HTMLElement>) => void;
}

export default function WindowResize({ onPointerDown, onKeyDown }: Props) {
  return (
    <div className="mf-window-resize pointer-events-none absolute inset-0 z-20">
      {EDGES.map((item) => {
        const keyboard = item.edge === 'se';
        return (
          <div
            key={item.edge}
            role={keyboard ? 'separator' : undefined}
            aria-label={keyboard ? item.label : undefined}
            aria-hidden={keyboard ? undefined : true}
            title={
              keyboard
                ? 'Glisser pour redimensionner. Flèches pour ajuster, Maj pour aller plus vite.'
                : item.label
            }
            tabIndex={keyboard ? 0 : undefined}
            onPointerDown={(event) => onPointerDown(item.edge, event)}
            onKeyDown={keyboard ? (event) => onKeyDown(item.edge, event) : undefined}
            className={cn(
              'pointer-events-auto absolute touch-none',
              item.cursor,
              item.className,
              keyboard && 'text-ink-muted focus-visible:bg-accent/30 focus-visible:outline-none',
            )}
          >
            {keyboard && (
              <span
                aria-hidden
                className="mf-window-grip pointer-events-none absolute right-0.5 bottom-0.5 size-2.5"
                style={{
                  backgroundImage: 'radial-gradient(currentColor 0.9px, transparent 1.1px)',
                  backgroundSize: '4px 4px',
                  backgroundPosition: 'right bottom',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
