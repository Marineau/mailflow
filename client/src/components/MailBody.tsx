import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Loader2 } from './icons';
import { MAIL_PLATE, adaptMailToDark, mailFrameCss, mailFrameLockCss } from '../lib/darkMail';
import { layoutFragment, peelHeavyPictures, type PeeledPicture } from '../lib/heavyImages';
import { needsPlate, useInlinePlates } from '../lib/mailPlates';
import { highlightHtml, highlightText } from '../lib/highlight';
import { releaseRemoteCss } from '../lib/remoteCss';
import { useAppearance } from '../lib/theme';
import { cn, formatSize } from '../lib/utils';

interface Props {
  html: string | null;
  text: string | null;
  dark: boolean;
  highlight: string;
  showRemoteImages: boolean;
  attachments: { filename: string; size: number }[];
  urlFor: (index: number) => string;
}

/**
 * Heavy pictures are buttons in the parent, one per picture. The mail HTML
 * stays in a sandboxed frame, so a picture is fetched only after its button.
 */
export default function MailBody({
  html,
  text,
  dark,
  highlight,
  showRemoteImages,
  attachments,
  urlFor,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { theme } = useAppearance();

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const apply = () => setWidth(el.clientWidth);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // In dark mode the inline pictures are looked at first: the ones drawn in
  // dark ink on a transparent ground get a light plate, and that has to be
  // known before the message frame is built.
  const platesReady = useInlinePlates(html, dark);

  const model = useMemo(() => {
    const frameCss = `${mailFrameCss(dark)}\n${mailFrameLockCss()}`;
    if (!platesReady) return { css: frameCss, parts: [] };
    if (!html) {
      const plain = highlight ? highlightText(text ?? '', highlight) : escapeHtml(text ?? '');
      return { css: frameCss, parts: [{ type: 'html' as const, html: `<pre>${plain}</pre>` }] };
    }

    const peeled = peelHeavyPictures(html, attachments);
    let body = peeled.html;
    // Remote content is one consent: the pictures and what the CSS names.
    if (showRemoteImages) body = releaseRemoteCss(body.replace(/data-src=/g, 'src='));
    if (dark) body = adaptMailToDark(body);
    if (highlight) body = highlightHtml(body, highlight);

    const laid = layoutFragment(body, peeled.pictures);
    return {
      css: `${frameCss}\n${laid.css}\n${mailFrameLockCss()}`,
      parts: laid.parts,
    };
  }, [html, text, dark, highlight, showRemoteImages, attachments, platesReady]);

  return (
    <div
      ref={scroller}
      // The page under the message is white or black whatever the app's mode
      // is: a message shown undarkened in dark mode sits on a white page. The
      // controls drawn on that page (HeavyPicture) take the tokens of the
      // page's mode, not the app's — the same nested `data-theme`/`data-mode`
      // that draws a theme thumbnail. `text-ink` re-reads the token here:
      // an inherited color would still be the app's.
      data-theme={theme}
      data-mode={dark ? 'dark' : 'light'}
      className={cn(
        'relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain text-ink',
        dark ? 'bg-black' : 'bg-white',
      )}
    >
      {model.parts.map((part, index) =>
        part.type === 'html' ? (
          <MailChunk key={index} css={model.css} html={part.html} width={width} />
        ) : (
          <HeavyPicture
            key={index}
            picture={part.picture}
            url={pictureUrl(part.picture, urlFor)}
            dark={dark}
          />
        ),
      )}
    </div>
  );
}

function pictureUrl(picture: PeeledPicture, urlFor: (index: number) => string): string | null {
  if (picture.inlineSrc) return picture.inlineSrc;
  if (picture.file != null) return urlFor(picture.file);
  return null;
}

function MailChunk({ css, html, width }: { css: string; html: string; width: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="mf-root">${html}</div></body></html>`,
    [css, html],
  );

  useLayoutEffect(() => {
    const el = host.current;
    if (!el || width <= 0) return;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.replaceChildren();
    const style = document.createElement('style');
    style.textContent = css;
    const root = document.createElement('div');
    root.className = 'mf-root';
    root.innerHTML = html;
    shadow.append(style, root);
    const apply = () => {
      const box = Math.max(root.scrollHeight, root.getBoundingClientRect().height);
      const style = getComputedStyle(root);
      const margin = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      setHeight(Math.ceil(box + (Number.isFinite(margin) ? margin : 0)));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(root);
    return () => observer.disconnect();
  }, [css, html, width]);

  return (
    <>
      <div
        ref={host}
        inert
        aria-hidden
        style={{
          position: 'fixed',
          left: -10000,
          top: 0,
          width,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
      />
      <iframe
        title="Contenu du message"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        scrolling="no"
        srcDoc={srcDoc}
        style={{ height: Math.max(height, 0) }}
        className="block w-full border-0"
      />
    </>
  );
}

function HeavyPicture({
  picture,
  url,
  dark,
}: {
  picture: PeeledPicture;
  url: string | null;
  dark: boolean;
}) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // Dark ink on a transparent ground: unreadable on the black page without a plate.
  const [plate, setPlate] = useState(false);

  useLayoutEffect(() => {
    if (phase !== 'loading' || !url) return;
    const image = new Image();
    image.onload = () => {
      setPlate(needsPlate(image));
      setPhase('ready');
    };
    image.onerror = () => setPhase('error');
    image.src = url;
  }, [phase, url]);

  if (!url) return null;

  if (phase === 'ready') {
    return (
      <div className="my-2 px-5">
        <img
          src={url}
          alt={picture.name}
          className="block max-w-full"
          // The plate belongs to the mail page, like its white or black ground:
          // it is not one of the theme's tokens.
          style={
            dark && plate
              ? {
                  backgroundColor: MAIL_PLATE,
                  borderRadius: 3,
                  boxShadow: `0 0 0 3px ${MAIL_PLATE}`,
                }
              : undefined
          }
        />
      </div>
    );
  }

  const label =
    phase === 'loading' ? 'Chargement…' : phase === 'error' ? 'Échec — réessayer' : "Afficher l'image";

  return (
    <button
      type="button"
      disabled={phase === 'loading'}
      onClick={() => setPhase('loading')}
      title={picture.name}
      className="mf-btn mx-5 my-2 flex max-w-full items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-left text-xs hover:bg-surface-hover disabled:opacity-60"
    >
      {phase === 'loading' ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-ink-muted" />
      ) : (
        <ImageIcon className="size-3.5 shrink-0 text-ink-muted" />
      )}
      <span className="shrink-0">{label}</span>
      {picture.size ? <span className="shrink-0 text-ink-muted">{formatSize(picture.size)}</span> : null}
      {picture.name ? <span className="truncate text-ink-muted">{picture.name}</span> : null}
    </button>
  );
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
