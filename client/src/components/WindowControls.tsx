import { Minus, X } from './icons';

interface Props {
  onMinimize?: () => void;
  onClose: () => void;
}

/**
 * Caption buttons of a floating window, in the order every desktop used:
 * minimize, then close. `data-window-control` keeps a press on them from
 * starting a drag of the title bar.
 *
 * Themes draw them through `mf-window-min` and `mf-window-close`. The close
 * button has its own hook rather than sharing one, because several themes
 * colour it apart (Vista's red, Épure's red hover).
 */
export default function WindowControls({ onMinimize, onClose }: Props) {
  return (
    <>
      {onMinimize && (
        <button
          type="button"
          data-window-control
          onClick={onMinimize}
          aria-label="Réduire"
          title="Réduire"
          className="mf-window-min cursor-pointer rounded-md p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <Minus className="size-4" />
        </button>
      )}
      <button
        type="button"
        data-window-control
        onClick={onClose}
        aria-label="Fermer"
        title="Fermer"
        className="mf-window-close cursor-pointer rounded-md p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink"
      >
        <X className="size-4" />
      </button>
    </>
  );
}
