import { useEffect, useId, useRef } from 'react';
import { Check, GripHorizontal, Palette } from './icons';
import WindowControls from './WindowControls';
import { THEMES, setTheme, useAppearance, type Mode, type ThemeId } from '../lib/theme';
import { useWindowDrag } from '../lib/useWindowDrag';
import { useManagedWindow } from '../lib/windows';
import { cn } from '../lib/utils';

interface Props {
  onClose: () => void;
}

/**
 * Theme picker. A click applies the theme at once: the app behind the
 * window is the real preview, the thumbnails only help to choose.
 *
 * A floating window like the composer, not a modal: it can be dragged out
 * of the way of what it restyles, minimized to the taskbar, and the app
 * stays usable meanwhile. Escape still closes it while the focus is inside,
 * and the focus goes back to whatever opened it.
 */
export default function ThemeModal({ onClose }: Props) {
  const { theme, mode } = useAppearance();
  const { minimized, layer, activate, minimize } = useManagedWindow('themes', {
    label: 'Thèmes',
    icon: Palette,
  });
  const { panelRef, position, moving, handleProps } = useWindowDrag<HTMLDivElement>();
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The group's entry point is the theme in use.
    cards.current[THEMES.findIndex((item) => item.id === theme)]?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
    // Only on opening: later theme changes must not move the focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Radio group keys: an arrow moves the selection, not just the focus. */
  function onCardKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + THEMES.length) % THEMES.length;
    setTheme(THEMES[next].id);
    cards.current[next]?.focus();
  }

  return (
    <div
      ref={panelRef}
      id="mf-window-themes"
      tabIndex={-1}
      role="dialog"
      aria-labelledby={titleId}
      style={{ zIndex: layer, ...(position ? { left: position.x, top: position.y } : {}) }}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
      // The column lets the list of themes scroll on a short screen while
      // title and footer stay put. Centred until first dragged.
      className={cn(
        'mf-window pointer-events-auto fixed flex max-h-[calc(100dvh-2rem-var(--mf-taskbar-h,0px))] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl outline-none',
        position ? undefined : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
        moving && 'select-none',
        minimized && 'hidden',
      )}
    >
      <div
        title="Glisser pour déplacer"
        {...handleProps}
        className="mf-window-title flex shrink-0 cursor-grab touch-none items-center gap-1 border-b border-line px-4 py-3 select-none active:cursor-grabbing"
      >
        <h2 id={titleId} className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          <GripHorizontal className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <Palette className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          Thèmes
        </h2>
        <WindowControls onMinimize={minimize} onClose={onClose} />
      </div>

      <div className="mf-window-body flex min-h-0 flex-col">
        <div className="min-h-0 overflow-y-auto p-4">
          <p className="text-sm leading-relaxed text-ink-muted">
            Le thème change l'habillage de mailFlow. Le mode clair ou sombre se règle à part, avec
            le bouton voisin dans la barre du haut, et vaut pour tous les thèmes.
          </p>

          <div role="radiogroup" aria-label="Thème" className="mt-4 grid grid-cols-2 gap-3">
            {THEMES.map((item, index) => {
              const selected = item.id === theme;
              return (
                <button
                  key={item.id}
                  ref={(node) => {
                    cards.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTheme(item.id)}
                  onKeyDown={(event) => onCardKeyDown(event, index)}
                  className={cn(
                    'mf-theme-card flex cursor-pointer flex-col gap-2.5 rounded-lg border p-3 text-left transition-colors',
                    selected ? 'border-accent bg-accent/10' : 'border-line hover:bg-surface-hover',
                  )}
                >
                  <ThemeThumb theme={item.id} mode={mode} />
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    {selected && (
                      <Check className="ml-auto size-4 shrink-0 text-accent" aria-hidden="true" />
                    )}
                  </span>
                  <span className="text-xs leading-relaxed text-ink-muted">{item.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mf-window-foot flex shrink-0 justify-end border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="mf-btn cursor-pointer rounded-md border border-line px-4 py-1.5 text-sm hover:bg-surface-hover"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A miniature of the three panes, drawn with the theme's own tokens: the
 * element carries `data-theme` and `data-mode`, so the token blocks in
 * `styles/themes/*.css` resolve on it exactly as they do on <html>. Nothing
 * here names a color — a new theme gets its preview for free, and adds
 * `.mf-thumb[data-theme='…']` rules only for what tokens cannot express.
 */
function ThemeThumb({ theme, mode }: { theme: ThemeId; mode: Mode }) {
  return (
    <span
      aria-hidden="true"
      data-theme={theme}
      data-mode={mode}
      className="mf-thumb flex h-32 flex-col overflow-hidden rounded-md border border-line bg-canvas"
    >
      <span className="mf-thumb-bar flex h-6 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <span className="mf-thumb-brand h-1.5 w-6 rounded-sm bg-ink" />
        <span className="mf-thumb-field h-2.5 w-14 rounded-sm bg-surface" />
        <span className="mf-thumb-cta ml-auto h-2.5 w-8 rounded-sm bg-accent" />
      </span>

      <span className="mf-thumb-panes flex min-h-0 flex-1">
        <span className="mf-thumb-nav flex w-1/4 flex-col gap-1.5 border-r border-line p-1.5">
          <span className="mf-thumb-sel flex h-3 items-center rounded-sm bg-surface px-1">
            <span className="h-1 w-3/5 rounded-sm bg-ink" />
          </span>
          <span className="mx-1 h-1 w-3/4 rounded-sm bg-ink-muted/60" />
          <span className="mx-1 h-1 w-1/2 rounded-sm bg-ink-muted/60" />
          <span className="mx-1 h-1 w-2/3 rounded-sm bg-ink-muted/60" />
        </span>

        <span className="mf-thumb-list flex w-1/3 flex-col border-r border-line">
          <span className="flex flex-col gap-1 border-b border-line p-1.5">
            <span className="h-1 w-1/2 rounded-sm bg-ink" />
            <span className="h-1 w-4/5 rounded-sm bg-ink-muted/60" />
          </span>
          <span className="mf-thumb-sel flex flex-col gap-1 border-b border-line bg-surface p-1.5">
            <span className="h-1 w-2/3 rounded-sm bg-ink" />
            <span className="h-1 w-3/4 rounded-sm bg-ink-muted/60" />
          </span>
          <span className="flex flex-col gap-1 border-b border-line p-1.5">
            <span className="h-1 w-2/5 rounded-sm bg-ink" />
            <span className="h-1 w-3/5 rounded-sm bg-ink-muted/60" />
          </span>
        </span>

        <span className="mf-thumb-reader flex min-w-0 flex-1 flex-col">
          <span className="mf-thumb-head flex flex-col gap-1 border-b border-line p-1.5">
            <span className="h-1.5 w-3/5 rounded-sm bg-ink" />
            <span className="h-1 w-2/5 rounded-sm bg-ink-muted/60" />
          </span>
          <span className="flex flex-col gap-1 p-1.5">
            <span className="h-1 w-full rounded-sm bg-ink-muted/40" />
            <span className="h-1 w-11/12 rounded-sm bg-ink-muted/40" />
            <span className="h-1 w-3/4 rounded-sm bg-ink-muted/40" />
          </span>
        </span>
      </span>
    </span>
  );
}
