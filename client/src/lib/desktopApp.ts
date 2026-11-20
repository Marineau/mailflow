/**
 * True inside the installed Windows app (desktop/main.ts), false in a browser.
 *
 * The page is the same in both and the app exposes nothing to it; the one
 * difference it must know about is that the app never opens a window of its
 * own: what the page opens goes to the system browser.
 */
export const IN_DESKTOP_APP = /\bElectron\/\d/.test(navigator.userAgent);
