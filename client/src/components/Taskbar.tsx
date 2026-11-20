import { restoreWindow, useMinimizedWindows } from '../lib/windows';

/**
 * The bar along the bottom of the app that holds minimized windows, one
 * button each, after the Windows 98 taskbar. It only exists while a window
 * is minimized; App reserves its height through `--mf-taskbar-h` so a
 * window pinned to the bottom stays above it.
 *
 * Each button is also an `mf-btn`: every theme already knows how to draw a
 * push button, and a taskbar button is one. `mf-taskbar` and
 * `mf-taskbar-item` let a theme go further (the Classique bar, Épure's
 * centred row).
 */
export default function Taskbar() {
  const entries = useMinimizedWindows();
  if (entries.length === 0) return null;
  return (
    <nav
      aria-label="Fenêtres réduites"
      className="mf-taskbar flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-surface px-3"
    >
      {entries.map(({ id, meta: { label, icon: Icon } }) => (
        <button
          key={id}
          type="button"
          data-taskbar-window={id}
          onClick={() => restoreWindow(id)}
          title={`Restaurer : ${label}`}
          className="mf-btn mf-taskbar-item flex h-8 w-48 min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-line px-3 text-left text-sm hover:bg-surface-hover"
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      ))}
    </nav>
  );
}
