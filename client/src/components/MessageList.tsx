import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Ban, Loader2, Paperclip, Reply, ReplyAll, Star } from './icons';
import { MARK_END, MARK_START, type MessageSummary, type SearchResult } from '../lib/api';
import { cn, displayName, formatListDate, recipientsLabel } from '../lib/utils';
import { MessageListSkeleton, SyncBar } from './Loader';

interface Props {
  messages: MessageSummary[];
  isLoading: boolean;
  error: Error | null;
  /** Un UID ne vaut que dans son dossier : la sélection se lit avec les deux. */
  selectedFolder: string | null;
  selectedUid: number | null;
  highlight: string;
  /** Dossier affiché : la recherche par défaut n'en sort pas. */
  searchFolderLabel: string;
  searchMeta: SearchResult | null;
  searchPending: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  /** Refetch of a folder already on screen — bar only, the rows stay. */
  refreshing: boolean;
  onLoadMore: () => void;
  onSelect: (message: MessageSummary) => void;
  onVisible: (message: MessageSummary) => void;
  onHidden: (message: MessageSummary) => void;
  /** Envoyés et brouillons : la ligne du haut est le destinataire, pas soi-même. */
  isOutbound: (folder: string) => boolean;
  /** Hover action: opens a reply window. Must be stable (rows are memoized). */
  onReply: (message: MessageSummary, replyAll: boolean) => Promise<void>;
  /** Hover action: toggles \Flagged, shown as "important". Must be stable. */
  onToggleImportant: (message: MessageSummary) => void;
}

/** Hauteur supposée d'une ligne avant sa mesure : expéditeur, objet, deux lignes d'extrait. */
const ROW_ESTIMATE = 96;

function MessageList({
  messages,
  isLoading,
  error,
  selectedFolder,
  selectedUid,
  highlight,
  searchFolderLabel,
  searchMeta,
  searchPending,
  hasMore,
  loadingMore,
  refreshing,
  onLoadMore,
  onSelect,
  onVisible,
  onHidden,
  isOutbound,
  onReply,
  onToggleImportant,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const observed = useRef(new Set<Element>());
  /** Lignes que l'observateur a déclarées visibles, avec le message annoncé. */
  const visible = useRef(new Map<string, MessageSummary>());
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  const byKey = useMemo(() => {
    const map = new Map<string, MessageSummary>();
    for (const message of messages) map.set(`${message.folder}:${message.uid}`, message);
    return map;
  }, [messages]);
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;

  /**
   * Fenêtrage : seules les lignes proches de la zone visible sont montées.
   * Sans lui, faire défiler un dossier de 24 000 mails gardait 24 000 boutons
   * dans la page. Les lignes n'ont pas toutes la même hauteur (extrait sur une
   * à trois lignes, dossier d'origine en recherche) : chacune est mesurée.
   *
   * La bannière de recherche et la barre de synchronisation vivent dans le même
   * conteneur défilant, au-dessus des lignes : `scrollMargin` est leur hauteur.
   */
  const [scrollMargin, setScrollMargin] = useState(0);
  // No dependency list on purpose: re-measured after every render; the
  // comparison at the end stops the loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const box = container.current;
    const list = rows.current;
    if (!box || !list) return;
    const top = Math.round(
      list.getBoundingClientRect().top -
        box.getBoundingClientRect().top -
        box.clientTop +
        box.scrollTop,
    );
    if (top !== scrollMargin) setScrollMargin(top);
  });

  // La clé suit le message, pas son rang : un mail qui arrive en tête décale
  // les rangs, pas les hauteurs déjà mesurées.
  const getItemKey = useCallback(
    (index: number) => {
      const message = messages[index];
      return message ? `${message.folder}:${message.uid}` : index;
    },
    [messages],
  );

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => container.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    scrollMargin,
    getItemKey,
  });
  const items = virtualizer.getVirtualItems();
  const offset = items.length > 0 ? items[0].start - scrollMargin : 0;

  // Charge la page suivante avant d'atteindre le bas, pour que le défilement
  // ne marque pas de pause visible.
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore) return;
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 400) onLoadMore();
  };

  useEffect(() => {
    const root = container.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.rowKey;
          if (!key) continue;
          const message = byKeyRef.current.get(key);
          if (!message) continue;
          if (entry.isIntersecting) {
            visible.current.set(key, message);
            onVisible(message);
          } else {
            visible.current.delete(key);
            onHidden(message);
          }
        }
      },
      { root, rootMargin: '100px' },
    );
    observer.current = io;
    for (const node of observed.current) io.observe(node);

    return () => {
      io.disconnect();
      if (observer.current === io) observer.current = null;
    };
  }, [onVisible, onHidden]);

  /**
   * Attache l'observateur à chaque ligne. Le nettoyage retire le nœud : sans
   * ça, changer de dossier garde les boutons démontés et leur texte en mémoire.
   *
   * Une ligne démontée par le fenêtrage alors qu'elle était visible (saut de
   * la barre de défilement) ne reçoit jamais le « sortie d'écran » de
   * l'observateur : on l'annonce ici, sinon son préchargement resterait armé.
   */
  const observeRow = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    observed.current.add(node);
    observer.current?.observe(node);
    return () => {
      observer.current?.unobserve(node);
      observed.current.delete(node);
      const key = node.dataset.rowKey;
      const message = key ? visible.current.get(key) : undefined;
      if (key && message) {
        visible.current.delete(key);
        onHiddenRef.current(message);
      }
    };
  }, []);

  return (
    <div
      ref={container}
      onScroll={handleScroll}
      className="mf-list flex h-full min-h-0 w-full flex-1 flex-col overflow-y-auto border-r border-line"
    >
      {(isLoading || refreshing || searchPending) && !loadingMore && <SyncBar />}

      {searchMeta && (
        <SearchBanner
          meta={searchMeta}
          pending={searchPending}
          count={messages.length}
          folderLabel={searchFolderLabel}
        />
      )}

      {isLoading && !error && <MessageListSkeleton />}
      {error && <p className="p-4 text-sm text-warn">{error.message}</p>}
      {!isLoading && !error && messages.length === 0 && (
        <p className="p-4 text-sm text-ink-muted">Aucun message.</p>
      )}

      {/* La hauteur est celle de toute la liste ; seules les lignes montées
          sont dans le flux, décalées jusqu'à leur place. `shrink-0` : sans lui
          la colonne flex écraserait ce bloc à la hauteur du conteneur. */}
      <div
        ref={rows}
        className="relative w-full shrink-0"
        style={{ height: virtualizer.getTotalSize() }}
      >
        <div
          className="absolute top-0 left-0 flex w-full flex-col"
          style={{ transform: `translateY(${offset}px)` }}
        >
          {items.map((item) => {
            const message = messages[item.index];
            if (!message) return null;
            const active = message.uid === selectedUid && message.folder === selectedFolder;

            return (
              // L'enveloppe est ce qui est mesuré. En flex, elle contient les
              // marges que certains thèmes donnent à la ligne.
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="flex flex-col"
              >
                <Row
                  message={message}
                  active={active}
                  highlight={highlight}
                  outbound={isOutbound(message.folder)}
                  showFolder={searchMeta?.scope === 'all'}
                  observe={observeRow}
                  onSelect={onSelect}
                  onReply={onReply}
                  onToggleImportant={onToggleImportant}
                />
              </div>
            );
          })}
        </div>
      </div>

      {loadingMore && <MessageListSkeleton rows={2} label="Chargement de la suite" />}
      {!hasMore && !searchMeta && messages.length > 0 && (
        <p className="p-3 text-center text-xs text-ink-muted/60">Fin du dossier</p>
      )}
    </div>
  );
}

export default memo(MessageList);

/**
 * Une ligne de la liste. Mémoïsée : pendant un défilement, seules les lignes
 * qui entrent dans la fenêtre sont rendues, les autres ne bougent pas.
 */
const Row = memo(function Row({
  message,
  active,
  highlight,
  outbound,
  showFolder,
  observe,
  onSelect,
  onReply,
  onToggleImportant,
}: {
  message: MessageSummary;
  active: boolean;
  highlight: string;
  /** Envoyés et brouillons : la ligne du haut est le destinataire. */
  outbound: boolean;
  /** Recherche « tous les dossiers » : le dossier d'origine s'affiche. */
  showFolder: boolean;
  observe: (node: HTMLElement | null) => (() => void) | undefined;
  onSelect: (message: MessageSummary) => void;
  onReply: (message: MessageSummary, replyAll: boolean) => Promise<void>;
  onToggleImportant: (message: MessageSummary) => void;
}) {
  // Which reply is fetching the message body before its window opens.
  const [replying, setReplying] = useState<'one' | 'all' | null>(null);
  const reply = (all: boolean) => {
    if (replying) return;
    setReplying(all ? 'all' : 'one');
    void onReply(message, all).finally(() => setReplying(null));
  };
  const important = message.flagged;

  // The actions sit beside the row button, not inside it: a button cannot
  // contain another. They show on hover, and on keyboard focus too, so they
  // stay in the tab order (faded out, never `hidden`).
  return (
    <div className="mf-row-wrap group relative flex flex-col">
    <button
      ref={observe}
      data-row-key={`${message.folder}:${message.uid}`}
      data-important={important || undefined}
      type="button"
      onClick={() => onSelect(message)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'mf-row relative flex flex-col gap-1 border-b border-line px-4 py-3 text-left transition-colors',
        active ? 'bg-surface' : 'hover:bg-surface-hover',
      )}
    >
      {/* Important: a flag-coloured stripe and tint laid over whatever
          background the theme gives the row (hover, selection), rather than
          replacing it. Low alpha, so it does not dim the text it covers. */}
      {important && (
        <span
          aria-hidden
          className="mf-row-important pointer-events-none absolute inset-0 rounded-[inherit] border-l-[3px] border-flag bg-flag/10"
        />
      )}
      <div className="flex items-baseline gap-2">
        {!message.seen && (
          <span className="mf-unread-dot size-2 shrink-0 rounded-full bg-accent" />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            message.seen ? 'text-ink-muted' : 'font-semibold text-ink',
          )}
        >
          <Highlighted
            text={outbound ? `À ${recipientsLabel(message.to)}` : displayName(message.from)}
            term={highlight}
          />
        </span>
        {message.senderBlocked && (
          <span title="Expéditeur bloqué" className="inline-flex shrink-0">
            <Ban className="size-3.5 text-warn" />
          </span>
        )}
        {message.flagged && <Star data-on className="size-3.5 shrink-0 fill-flag text-flag" />}
        {message.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-ink-muted" />}
        <span className="shrink-0 text-xs text-ink-muted">{formatListDate(message.date)}</span>
      </div>

      <span
        className={cn(
          'truncate text-sm',
          message.seen ? 'text-ink-muted' : 'font-medium text-ink',
        )}
      >
        <Highlighted text={message.subject} term={highlight} />
      </span>

      {/* En recherche, la phrase qui contient le terme vaut mieux que les
          premiers mots du mail — c'est elle qui dit pourquoi ce résultat
          est là. */}
      {message.excerpt ? (
        <span className="line-clamp-3 text-xs leading-relaxed text-ink-muted">
          <MarkedExcerpt excerpt={message.excerpt} />
        </span>
      ) : (
        message.snippet && (
          <span className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
            <Highlighted text={message.snippet} term={highlight} />
          </span>
        )
      )}

      {/* En recherche « tous les dossiers », savoir d'où vient un résultat
          évite d'ouvrir un mail en croyant être ailleurs. */}
      {showFolder && <span className="text-[11px] text-ink-muted/70">{message.folder}</span>}
    </button>

    <div
      className={cn(
        'mf-row-actions absolute right-3 top-2 z-[2] flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-md',
        'pointer-events-none opacity-0 transition-opacity',
        'group-hover:pointer-events-auto group-hover:opacity-100',
        'focus-within:pointer-events-auto focus-within:opacity-100',
        // Stays up while a reply is loading, even if the pointer has left.
        replying && 'pointer-events-auto opacity-100',
      )}
    >
      <RowAction title="Répondre" onClick={() => reply(false)}>
        {replying === 'one' ? <Loader2 className="size-4 animate-spin" /> : <Reply className="size-4" />}
      </RowAction>
      <RowAction title="Répondre à tous" onClick={() => reply(true)}>
        {replying === 'all' ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ReplyAll className="size-4" />
        )}
      </RowAction>
      <RowAction
        title={important ? "Retirer l'importance" : 'Marquer comme important'}
        pressed={important}
        onClick={() => onToggleImportant(message)}
      >
        <Star
          data-on={important || undefined}
          className={cn('size-4', important && 'fill-flag text-flag')}
        />
      </RowAction>
    </div>
    </div>
  );
});

function RowAction({
  title,
  pressed,
  onClick,
  children,
}: {
  title: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={onClick}
      className="mf-icon-btn flex size-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      {children}
    </button>
  );
}

function SearchBanner({
  meta,
  pending,
  count,
  folderLabel,
}: {
  meta: SearchResult;
  pending: boolean;
  count: number;
  folderLabel: string;
}) {
  const inFolder = meta.scope !== 'all';
  return (
    <div className="border-b border-line px-4 py-2 text-xs text-ink-muted">
      {pending ? (
        <span>{inFolder ? `Recherche dans ${folderLabel}…` : 'Interrogation du serveur…'}</span>
      ) : (
        <span>
          {count} résultat{count > 1 ? 's' : ''}
          {inFolder ? ` dans ${folderLabel}` : ''}
          {meta.scope === 'local'
            ? ` — parmi ${meta.coverage.indexed.toLocaleString('fr-FR')} mails indexés sur ${meta.coverage.total.toLocaleString('fr-FR')}`
            : ` — ${meta.searchedFolders.length} dossier${
                meta.searchedFolders.length > 1 ? 's' : ''
              } interrogé${meta.searchedFolders.length > 1 ? 's' : ''} sur le serveur`}
        </span>
      )}

      {meta.scope === 'local' && meta.coverage.indexed < meta.coverage.total && (
        <div className="mt-1 text-ink-muted/70">
          L'indexation de ce dossier est incomplète — cochez « tous les mails » pour interroger
          le serveur.
        </div>
      )}

      {meta.errors.length > 0 && (
        <div className="mt-1 text-warn/80">
          {meta.errors.map((message) => (
            <Fragment key={message}>
              <span className="block">{message}</span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Rend l'extrait fabriqué par FTS5. Les bornes sont des caractères de contrôle :
 * on découpe dessus et on rend du texte, jamais du HTML — l'extrait vient du
 * corps d'un mail, c'est-à-dire de contenu tiers.
 */
function MarkedExcerpt({ excerpt }: { excerpt: string }) {
  const pieces = excerpt.split(MARK_START);

  return (
    <>
      {pieces.map((piece, index) => {
        if (index === 0) return <Fragment key={index}>{piece}</Fragment>;
        const [matched, ...rest] = piece.split(MARK_END);
        return (
          <Fragment key={index}>
            <mark className="rounded-sm bg-accent/25 text-ink">{matched}</mark>
            {rest.join(MARK_END)}
          </Fragment>
        );
      })}
    </>
  );
}

/** Surligne le terme cherché, sans interpréter la saisie comme une regex. */
function Highlighted({ text, term }: { text: string; term: string }) {
  if (!term || term.length < 2) return <>{text}</>;

  const needle = term.toLowerCase();
  const haystack = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (;;) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={index} className="rounded-sm bg-accent/25 text-ink">
        {text.slice(index, index + term.length)}
      </mark>,
    );
    cursor = index + term.length;
  }

  if (parts.length === 0) return <>{text}</>;
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
