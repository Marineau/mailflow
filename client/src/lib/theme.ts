/**
 * Appearance is two independent choices: a theme (the skin) and a mode (light
 * or dark). Both live as attributes on <html>. Every color token and every
 * skin rule in `styles/themes/*.css` is keyed on `[data-theme][data-mode]`,
 * so switching either one is a single attribute write — no re-render needed
 * for the colors to follow.
 *
 * `index.html` sets the same two attributes from the same two storage keys
 * before first paint. This module then validates what it finds: a theme that
 * no longer exists falls back to the default instead of leaving the page with
 * no matching token block.
 */
import { useSyncExternalStore } from 'react';

export type Mode = 'light' | 'dark';

/** Adding a theme: one entry here, one stylesheet in `styles/themes/`. */
export const THEMES = [
  {
    id: 'mailflow',
    name: 'mailFlow',
    description: "L'habillage d'origine : à plat, discret, un seul accent.",
  },
  {
    id: 'vista',
    name: 'Cristal',
    description: 'Cadres en verre, boutons à reflets et sélection bleutée.',
  },
  {
    id: 'win98',
    name: 'Classique',
    description: 'Gris en relief, angles droits et barre de titre bleu marine.',
  },
  {
    id: 'win11',
    name: 'Épure',
    description: "Fond dépoli, coins arrondis et pastille d'accent sur la sélection.",
  },
  {
    id: 'waterraria',
    name: 'Récif',
    description: "L'océan en pixels : cases d'inventaire, liseré doré, bulles et coraux.",
  },
  {
    id: 'pocket',
    name: 'Arène',
    description: 'Tuiles vives cadrées de bleu électrique et boutons de verre en biais.',
  },
  {
    id: 'tiddl',
    name: 'Papeterie',
    description: 'Papier à lettres pastel : ciel semé d’étoiles, bouton en part de fromage, coutures et empreintes.',
  },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export interface Appearance {
  theme: ThemeId;
  mode: Mode;
}

/** Also read by the inline script in `index.html`. Rename both together. */
const THEME_KEY = 'mailflow.theme';
const MODE_KEY = 'mailflow.mode';

/** What the app looked like before themes existed. */
const DEFAULT: Appearance = { theme: 'mailflow', mode: 'dark' };

function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function read(): Appearance {
  let theme: string | null = null;
  let mode: string | null = null;
  try {
    theme = localStorage.getItem(THEME_KEY);
    mode = localStorage.getItem(MODE_KEY);
  } catch {
    /* private browsing: the choice lives as long as the tab */
  }
  return {
    theme: isThemeId(theme) ? theme : DEFAULT.theme,
    mode: mode === 'light' || mode === 'dark' ? mode : DEFAULT.mode,
  };
}

function apply(appearance: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = appearance.theme;
  root.dataset.mode = appearance.mode;
}

let current = read();
apply(current);

const listeners = new Set<() => void>();

function commit(next: Appearance): void {
  if (next.theme === current.theme && next.mode === current.mode) return;
  current = next;
  apply(next);
  try {
    localStorage.setItem(THEME_KEY, next.theme);
    localStorage.setItem(MODE_KEY, next.mode);
  } catch {
    /* private browsing */
  }
  for (const listener of listeners) listener();
}

// A second tab on the same mailbox follows the first one.
window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key !== THEME_KEY && event.key !== MODE_KEY) return;
  const next = read();
  if (next.theme === current.theme && next.mode === current.mode) return;
  current = next;
  apply(next);
  for (const listener of listeners) listener();
});

export function setTheme(theme: ThemeId): void {
  commit({ ...current, theme });
}

export function setMode(mode: Mode): void {
  commit({ ...current, mode });
}

export function toggleMode(): void {
  setMode(current.mode === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => current);
}
