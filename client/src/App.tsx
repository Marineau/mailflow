import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AlertCircle,
  Folder,
  Loader2,
  Moon,
  Palette,
  PenSquare,
  RefreshCw,
  Search,
  Sun,
  Users,
} from './components/icons';
import {
  api,
  type Account,
  type FullMessage,
  type MessageSummary,
  type SearchResult,
  type SearchScope,
} from './lib/api';
import { alertDialog } from './lib/dialog';
import { toggleMode, useAppearance } from './lib/theme';
import { useBusyCursor } from './lib/busyCursor';
import { IN_DESKTOP_APP } from './lib/desktopApp';
import { cn, folderLabel, indexKey, isOutboundFolder } from './lib/utils';
import Sidebar from './components/Sidebar';
import MessageList from './components/MessageList';
import MessageView from './components/MessageView';
import Composer, { type ComposerDraft } from './components/Composer';
import { forwardQuote, forwardSubject, replyQuote, replySubject } from './lib/quote';
import SendToast, { type SendActivity, type SendToastState } from './components/SendToast';
import ThemeModal from './components/ThemeModal';
import AccountsWindow from './components/AccountsWindow';
import AccountSetup from './components/AccountSetup';
import Taskbar from './components/Taskbar';
import DialogHost from './components/DialogHost';
import { restoreWindow, useMinimizedWindows } from './lib/windows';
import { MessageBodySkeleton } from './components/Loader';
import ListSplit, { useMessageListWidth } from './components/ListSplit';
import { Prefetcher } from './lib/prefetch';
import { newOpId, reportProgress } from './lib/progress';
import ProgressFill from './components/ProgressFill';

const APP_NAME = 'mailFlow';

interface OpenComposer {
  key: number;
  draft: ComposerDraft;
  account: Account;
  /** Offset step from the corner, so a new window never hides the last one. */
  cascade: number;
}

export interface IndexProgress {
  phase: 'idle' | 'headers' | 'bodies' | 'done' | 'error';
  done: number;
  total: number;
  message?: string;
}

export default function App() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string>('INBOX');
  const [selected, setSelected] = useState<MessageSummary | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // By default a search stays in the displayed folder, on the local index.
  // The "all mail" button asks the IMAP server, across every folder, for the
  // query typed at the time of the click only: it is a slow network action,
  // so editing the query falls back to the local search until clicked again.
  const [everywhereFor, setEverywhereFor] = useState<string | null>(null);
  const scope: SearchScope =
    everywhereFor !== null && everywhereFor === debouncedSearch ? 'all' : 'local';
  // Every message being written, each in its own window. The account is the
  // one active when the window was opened: switching mailbox later does not
  // move a half-written message to another sender.
  const [composers, setComposers] = useState<OpenComposer[]>([]);
  const composerSequence = useRef(0);
  const [sendToast, setSendToast] = useState<SendToastState | null>(null);
  const sendToastId = useRef(0);
  const { mode } = useAppearance();
  const listPane = useMessageListWidth();
  const [themesOpen, setThemesOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const taskbarShown = useMinimizedWindows().length > 0;
  const [indexing, setIndexing] = useState<Record<string, IndexProgress>>({});
  const [manualRefresh, setManualRefresh] = useState(false);
  useBusyCursor(manualRefresh);
  const refreshOp = useRef<string | null>(null);
  const [refreshOpId, setRefreshOpId] = useState<string | null>(null);
  const [justFresh, setJustFresh] = useState(false);
  const freshTimer = useRef<number | null>(null);
  const lastFetchAt = useRef(0);
  const refreshing = useRef(false);
  const sawList = useRef(false);

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  // Le premier compte est retenu dès que la liste arrive : attendre un effet
  // laissait une image de boîte vide avant que les chargeurs puissent démarrer.
  const activeAccountId = accountId ?? accountsQuery.data?.[0]?.id ?? null;
  const [inboxReady, setInboxReady] = useState(false);
  // Vrai seulement après un changement de dossier ou de compte, pour que la barre
  // de synchro ne s'allume pas à chaque push IMAP.
  const [folderSyncing, setFolderSyncing] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Un mail qui arrive pendant que l'écran est ouvert doit s'afficher tout seul :
  // le serveur pousse l'événement IMAP, on invalide le cache correspondant.
  // Une coupure referme la source et en rouvre une, avec un délai qui plafonne :
  // le navigateur, lui, retenterait sans limite.
  useEffect(() => {
    let source: EventSource | null = null;
    let retry = 0;
    let timer = 0;
    let stopped = false;
    let reconnecting = false;

    const connect = () => {
      if (stopped) return;
      reconnecting = false;
      const current = new EventSource('/api/events');
      source = current;
      current.onopen = () => {
        retry = 0;
      };
      current.onmessage = (event) => {
        let payload: {
          type: string;
          account: string;
          path?: string;
          index?: IndexProgress;
          op?: string;
          progress?: { at: number; next: number; eta?: number };
        };
        try {
          payload = JSON.parse(event.data) as typeof payload;
        } catch {
          return;
        }

        // A checkpoint of a long request, for the button that started it.
        if (payload.type === 'progress') {
          if (payload.op && payload.progress) {
            const { at, next, eta } = payload.progress;
            reportProgress(payload.op, at, next, eta);
          }
          return;
        }

        if (payload.type === 'index' && payload.index) {
          // Keyed by account too: two accounts both have an INBOX.
          const key = indexKey(payload.account, payload.path ?? '');
          setIndexing((prev) => ({ ...prev, [key]: payload.index as IndexProgress }));
          // La liste se remplit au fil de l'indexation des en-têtes ; inutile en
          // revanche de la rafraîchir à chaque lot de corps, qui n'ajoute rien.
          if (payload.index.phase !== 'bodies') {
            queryClient.invalidateQueries({ queryKey: ['messages', payload.account] });
            queryClient.invalidateQueries({ queryKey: ['senders', payload.account] });
          }
          return;
        }

        // La synchro des en-têtes enregistre les nouveaux expéditeurs. On
        // recharge le carnet seulement une fois cette écriture terminée.
        void queryClient.invalidateQueries({ queryKey: ['messages', payload.account] }).then(() => {
          void queryClient.invalidateQueries({ queryKey: ['senders', payload.account] });
        });
        queryClient.invalidateQueries({ queryKey: ['folders', payload.account] });
      };
      current.onerror = () => {
        // `close()` réémet l'erreur : sans ce garde, chaque coupure armerait
        // deux minuteries et deux connexions.
        if (stopped || reconnecting || source !== current) return;
        reconnecting = true;
        current.close();
        if (source === current) source = null;
        const delay = Math.min(30_000, 1000 * 2 ** retry);
        retry += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      source?.close();
      source = null;
    };
  }, [queryClient]);

  const isSearching = debouncedSearch.length >= 2;

  // Names the server search so its button can follow it folder by folder.
  const searchOp = useMemo(
    () => (scope === 'all' ? newOpId() : null),
    // A fresh id per search: the extra dependencies are the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, debouncedSearch, activeAccountId, folderPath],
  );

  const searchQuery = useQuery({
    queryKey: ['search', activeAccountId, folderPath, debouncedSearch, scope],
    queryFn: () => api.search(debouncedSearch, activeAccountId, folderPath, scope, searchOp),
    enabled: isSearching,
    // Une recherche IMAP est un aller-retour réseau : on ne la rejoue pas
    // tant que la requête n'a pas changé.
    staleTime: 5 * 60_000,
  });

  const PAGE_SIZE = 50;

  const listQuery = useInfiniteQuery({
    queryKey: ['messages', activeAccountId, folderPath],
    queryFn: ({ pageParam }) =>
      api.messages(
        activeAccountId as string,
        folderPath,
        pageParam as number,
        PAGE_SIZE,
        // Only the first page syncs with the server, and only a refresh asked
        // from the button is followed by its fill.
        pageParam === 0 ? refreshOp.current : null,
      ),
    initialPageParam: 0,
    // Une page incomplète signifie qu'on a atteint le fond du dossier.
    // L'offset vient de la page précédente : aplatir toutes les pages à chaque
    // appel recopiait toute la liste déjà chargée.
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.length < PAGE_SIZE ? undefined : (lastPageParam as number) + lastPage.length,
    enabled: !isSearching && Boolean(activeAccountId),
  });

  if (!inboxReady && !isSearching && listQuery.isSuccess) setInboxReady(true);

  useEffect(() => {
    if (folderSyncing && !listQuery.isFetching && (listQuery.isSuccess || listQuery.isError)) {
      setFolderSyncing(false);
    }
  }, [folderSyncing, listQuery.isFetching, listQuery.isSuccess, listQuery.isError]);

  useEffect(() => {
    sawList.current = false;
    lastFetchAt.current = 0;
  }, [activeAccountId, folderPath]);

  useEffect(() => {
    if (listQuery.isSuccess && !sawList.current) {
      sawList.current = true;
      lastFetchAt.current = listQuery.dataUpdatedAt || Date.now();
    }
  }, [listQuery.isSuccess, listQuery.dataUpdatedAt]);

  useEffect(() => {
    if (manualRefresh && !listQuery.isFetching && (listQuery.isSuccess || listQuery.isError)) {
      lastFetchAt.current = Date.now();
      refreshing.current = false;
      refreshOp.current = null;
      setManualRefresh(false);
    }
  }, [manualRefresh, listQuery.isFetching, listQuery.isSuccess, listQuery.isError]);

  const activeQuery = isSearching ? searchQuery : listQuery;
  const listMessages = useMemo(
    () => listQuery.data?.pages.flat() ?? [],
    [listQuery.data],
  );
  const messages = isSearching ? (searchQuery.data?.messages ?? []) : listMessages;

  const fetchNextPage = useRef(listQuery.fetchNextPage);
  fetchNextPage.current = listQuery.fetchNextPage;
  const loadMore = useCallback(() => {
    void fetchNextPage.current();
  }, []);

  const prefetcher = useMemo(() => new Prefetcher(queryClient), [queryClient]);
  useEffect(() => () => prefetcher.dispose(), [prefetcher]);

  const handleVisible = useCallback(
    (message: MessageSummary) => {
      if (activeAccountId) prefetcher.enter(activeAccountId, message);
    },
    [activeAccountId, prefetcher],
  );

  const handleHidden = useCallback(
    (message: MessageSummary) => {
      if (activeAccountId) prefetcher.leave(activeAccountId, message);
    },
    [activeAccountId, prefetcher],
  );

  /**
   * Applies `patch` to one message wherever it is shown: the folder list, any
   * search result, and the open message. Without the last one the reading
   * pane kept the state it had when the message was clicked.
   */
  const patchSummary = useCallback(
    (target: MessageSummary, patch: Partial<MessageSummary>) => {
      const same = (m: MessageSummary) =>
        m.account === target.account && m.folder === target.folder && m.uid === target.uid;
      const apply = (m: MessageSummary) => (same(m) ? { ...m, ...patch } : m);
      queryClient.setQueriesData<InfiniteData<MessageSummary[]>>(
        { queryKey: ['messages', target.account] },
        (data) => data && { ...data, pages: data.pages.map((page) => page.map(apply)) },
      );
      queryClient.setQueriesData<SearchResult>(
        { queryKey: ['search'] },
        (data) => data && { ...data, messages: data.messages.map(apply) },
      );
      setSelected((current) => (current && same(current) ? { ...current, ...patch } : current));
    },
    [queryClient],
  );

  /** "Important" is the IMAP \Flagged flag: Outlook shows it as its own flag. */
  const toggleImportant = useCallback(
    async (message: MessageSummary) => {
      const next = !message.flagged;
      patchSummary(message, { flagged: next });
      try {
        await api.setFlags(
          message.account,
          message.folder,
          message.uid,
          next ? ['\\Flagged'] : [],
          next ? [] : ['\\Flagged'],
        );
      } catch (error) {
        patchSummary(message, { flagged: !next });
        await alertDialog({
          title: 'Modification impossible',
          message: `Le serveur a refusé le changement : ${(error as Error).message}`,
        });
      }
    },
    [patchSummary],
  );

  function replyTo(full: FullMessage, all: boolean) {
    openDraft({
      kind: 'reply',
      to: full.from?.address ?? '',
      cc: all ? full.cc.map((c) => c.address).join(', ') : '',
      subject: replySubject(full.subject),
      body: replyQuote(full.text ?? '', full.from?.address ?? '', full.date),
      inReplyTo: full.messageId,
      references: [...full.references, full.messageId].filter(Boolean) as string[],
    });
  }
  // The rows are memoized: they get a stable callback that reads the latest
  // `replyTo` (which depends on the current account) through a ref.
  const replyToRef = useRef(replyTo);
  replyToRef.current = replyTo;

  /** Reply from the list: the quote needs the body, cached if prefetched. */
  const replyFromList = useCallback(
    async (message: MessageSummary, all: boolean) => {
      try {
        const full = await queryClient.fetchQuery({
          queryKey: ['message', message.account, message.folder, message.uid],
          queryFn: () => api.message(message.account, message.folder, message.uid),
          staleTime: Infinity,
          gcTime: 5 * 60_000,
        });
        replyToRef.current(full, all);
      } catch (error) {
        await alertDialog({
          title: 'Réponse impossible',
          message: `Le message n'a pas pu être chargé : ${(error as Error).message}`,
        });
      }
    },
    [queryClient],
  );

  const foldersQuery = useQuery({
    queryKey: ['folders', activeAccountId],
    queryFn: () => api.folders(activeAccountId as string),
    enabled: Boolean(activeAccountId),
  });

  const outboundPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const folder of foldersQuery.data ?? []) {
      if (isOutboundFolder(folder)) paths.add(folder.path);
    }
    return paths;
  }, [foldersQuery.data]);

  const isOutbound = useCallback(
    (path: string) => outboundPaths.has(path),
    [outboundPaths],
  );

  const searchFolderLabel = useMemo(() => {
    const folder = foldersQuery.data?.find((item) => item.path === folderPath);
    return folder ? folderLabel(folder) : folderPath;
  }, [foldersQuery.data, folderPath]);

  const currentAccount = useMemo(
    () => accountsQuery.data?.find((a) => a.id === activeAccountId) ?? null,
    [accountsQuery.data, activeAccountId],
  );

  const reportSend = useCallback((activity: SendActivity) => {
    if (activity.phase === 'sending') {
      const id = sendToastId.current + 1;
      sendToastId.current = id;
      setSendToast({ ...activity, id });
      return;
    }
    setSendToast({ ...activity, id: sendToastId.current });
  }, []);

  const dismissSendToast = useCallback(() => setSendToast(null), []);

  /**
   * Opens one more composer window on `next`, above the others, with the
   * focus in it. The ones already open are left as they are.
   */
  function openDraft(next: ComposerDraft) {
    if (!currentAccount) return;
    composerSequence.current += 1;
    const key = composerSequence.current;
    setComposers((open) => [
      ...open,
      { key, draft: next, account: currentAccount, cascade: open.length % 6 },
    ]);
    requestAnimationFrame(() => document.getElementById(`mf-window-composer-${key}`)?.focus());
  }

  function closeComposer(key: number) {
    setComposers((open) => open.filter((entry) => entry.key !== key));
  }

  useEffect(
    () => () => {
      if (freshTimer.current) window.clearTimeout(freshTimer.current);
    },
    [],
  );

  /** Récupère les derniers mails du dossier ouvert. Un appel de moins de 5 s est ignoré. */
  function refreshMailbox() {
    if (!activeAccountId || refreshing.current) return;
    const wasSearching = Boolean(search || debouncedSearch);
    if (wasSearching) {
      setSearch('');
      setDebouncedSearch('');
    }
    const syncInFlight = listQuery.isFetching && !listQuery.isFetchingNextPage;
    if (syncInFlight || (lastFetchAt.current > 0 && Date.now() - lastFetchAt.current < 5_000)) {
      if (!syncInFlight) {
        setJustFresh(true);
        if (freshTimer.current) window.clearTimeout(freshTimer.current);
        freshTimer.current = window.setTimeout(() => setJustFresh(false), 1200);
      }
      return;
    }
    refreshing.current = true;
    const op = newOpId();
    refreshOp.current = op;
    setRefreshOpId(op);
    setJustFresh(false);
    if (freshTimer.current) window.clearTimeout(freshTimer.current);
    setManualRefresh(true);
    setFolderSyncing(true);
    // Quitter la recherche réactive la liste, qui part chercher la première page.
    if (!wasSearching) void listQuery.refetch();
  }

  if (accountsQuery.isError) {
    return <FatalError message={(accountsQuery.error as Error).message} />;
  }

  if (accountsQuery.data && accountsQuery.data.length === 0) {
    return <Welcome />;
  }

  if (currentAccount && !currentAccount.authorized) {
    return (
      <NeedsConsent
        account={currentAccount}
        others={(accountsQuery.data ?? []).filter((a) => a.id !== currentAccount.id && a.authorized)}
        onSwitch={(id) => {
          setAccountId(id);
          setFolderPath('INBOX');
          setSelected(null);
        }}
      />
    );
  }

  return (
    <div
      className="mf-app flex h-full flex-col bg-canvas text-ink"
      data-taskbar={taskbarShown || undefined}
    >
      {/* Barre de titre de fenêtre, pour un thème qui en dessine une au-dessus de
          la barre d'outils. Masquée ailleurs : le nom est alors dans `mf-brand`. */}
      <div className="mf-caption hidden">{APP_NAME}</div>
      <header className="mf-titlebar flex h-16 shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="mf-brand text-sm font-semibold tracking-tight">{APP_NAME}</span>

        <div className="relative ml-4 max-w-md flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              scope === 'all'
                ? 'Rechercher dans tous les dossiers…'
                : 'Rechercher dans ce dossier…'
            }
            className="mf-input h-9 w-full rounded-md border border-line bg-surface pr-3 pl-9 text-sm outline-none placeholder:text-ink-muted focus:border-accent"
          />
        </div>

        {isSearching &&
          (scope === 'all' ? (
            <button
              type="button"
              onClick={() => setEverywhereFor(null)}
              disabled={searchQuery.isFetching}
              aria-busy={searchQuery.isFetching}
              title="Revenir à la recherche dans le dossier affiché"
              className="mf-btn relative isolate flex h-9 shrink-0 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm hover:bg-surface-hover"
            >
              <ProgressFill op={searchOp} running={searchQuery.isFetching} kind="search" />
              {searchQuery.isFetching ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Recherche sur le serveur…
                </>
              ) : (
                <>
                  <Folder className="size-4" />
                  Ce dossier seulement
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEverywhereFor(debouncedSearch)}
              title="Interroge le serveur IMAP sur tous les dossiers, au-delà du dossier affiché. Plus lent."
              className="mf-btn flex h-9 shrink-0 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm hover:bg-surface-hover"
            >
              <Search className="size-4" />
              Chercher dans tous les mails
            </button>
          ))}

        <button
          type="button"
          onClick={refreshMailbox}
          disabled={!activeAccountId || manualRefresh}
          title="Récupérer les derniers mails"
          aria-busy={manualRefresh}
          className={cn(
            'mf-btn-primary relative isolate ml-auto flex h-9 min-w-36 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-on-accent',
            // A button filling with progress is busy, not unavailable: no fading.
            'transition-opacity hover:opacity-90',
            !manualRefresh && 'disabled:opacity-40',
          )}
        >
          <ProgressFill op={refreshOpId} running={manualRefresh} kind="refresh" />
          <RefreshCw className={cn('size-4', manualRefresh && 'animate-spin')} />
          {manualRefresh ? 'Actualisation…' : justFresh ? 'À jour' : 'Actualiser'}
        </button>
        <button
          type="button"
          onClick={() =>
            openDraft({
              kind: 'new',
              to: '',
              cc: '',
              subject: '',
              body: '',
              inReplyTo: null,
              references: [],
            })
          }
          disabled={!activeAccountId}
          className={cn(
            'mf-btn-primary flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-on-accent',
            'transition-opacity hover:opacity-90 disabled:opacity-40',
          )}
        >
          <PenSquare className="size-4" />
          Nouveau message
        </button>

        {/* Apparence : le mode d'un clic, les thèmes dans leur fenêtre. */}
        <div className="mf-titlebar-rule flex shrink-0 items-center gap-1 border-l border-line pl-3">
          <button
            type="button"
            onClick={toggleMode}
            title={mode === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'}
            aria-label={mode === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'}
            className="mf-icon-btn flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              // Already open (perhaps minimized): bring it back rather than open a second.
              if (themesOpen) restoreWindow('themes');
              else setThemesOpen(true);
            }}
            title="Thèmes"
            aria-label="Choisir un thème"
            aria-haspopup="dialog"
            className="mf-icon-btn flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Palette className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (accountsOpen) restoreWindow('accounts');
              else setAccountsOpen(true);
            }}
            title="Comptes"
            aria-label="Gérer les comptes"
            aria-haspopup="dialog"
            className="mf-icon-btn flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Users className="size-4" />
          </button>
        </div>
      </header>

      <div className="mf-workspace flex min-h-0 flex-1">
        <Sidebar
          accounts={accountsQuery.data ?? []}
          accountId={activeAccountId}
          folderPath={folderPath}
          onSelectAccount={(id) => {
            setAccountId(id);
            setFolderPath('INBOX');
            setSelected(null);
            setFolderSyncing(true);
          }}
          onSelectFolder={(path) => {
            setFolderPath(path);
            setSelected(null);
            setFolderSyncing(true);
          }}
          indexing={indexing}
          folderPathForIndex={folderPath}
        />

        <div ref={listPane.panesRef} className="flex h-full min-h-0 min-w-0 flex-1">
        <div
          ref={listPane.listRef}
          className={cn(
            'flex h-full min-h-0 shrink-0 flex-col overflow-hidden',
            listPane.width == null && 'w-96',
          )}
          style={listPane.width != null ? { width: listPane.width } : undefined}
        >
        <MessageList
          messages={messages}
          isLoading={!activeAccountId || activeQuery.isLoading}
          refreshing={
            folderSyncing &&
            !activeQuery.isLoading &&
            activeQuery.isFetching &&
            !listQuery.isFetchingNextPage
          }
          error={activeQuery.error as Error | null}
          selectedFolder={selected?.folder ?? null}
          selectedUid={selected?.uid ?? null}
          highlight={isSearching ? debouncedSearch : ''}
          searchFolderLabel={searchFolderLabel}
          searchMeta={isSearching ? (searchQuery.data ?? null) : null}
          searchPending={isSearching && searchQuery.isFetching}
          hasMore={!isSearching && Boolean(listQuery.hasNextPage)}
          loadingMore={listQuery.isFetchingNextPage}
          onLoadMore={loadMore}
          onSelect={setSelected}
          onVisible={handleVisible}
          onHidden={handleHidden}
          isOutbound={isOutbound}
          onReply={replyFromList}
          onToggleImportant={toggleImportant}
        />
        </div>

        <ListSplit
          dragging={listPane.dragging}
          limits={listPane.limits}
          onPointerDown={listPane.onPointerDown}
          onKeyDown={listPane.onKeyDown}
          onReset={listPane.reset}
        />

        {!inboxReady && !selected && !isSearching && !activeQuery.isError ? (
          <MessageBodySkeleton withChrome label="Chargement de la boîte" />
        ) : (
          <MessageView
            accountId={activeAccountId}
            summary={selected}
            isOutbound={isOutbound}
            highlight={isSearching ? debouncedSearch : ''}
            onReply={replyTo}
            onToggleImportant={toggleImportant}
            onForward={(full) =>
              openDraft({
                kind: 'forward',
                to: '',
                cc: '',
                subject: forwardSubject(full.subject),
                body: forwardQuote(full),
                inReplyTo: null,
                references: [],
                files: full.attachments.flatMap((attachment, index) => {
                  const inlineImage =
                    Boolean(attachment.cid) &&
                    attachment.contentType.toLowerCase().startsWith('image/');
                  if (inlineImage) return [];
                  return [
                    {
                      filename: attachment.filename || 'piece-jointe',
                      contentType: attachment.contentType || 'application/octet-stream',
                      url: api.attachmentUrl(full.account, full.folder, full.uid, index),
                    },
                  ];
                }),
              })
            }
            onChanged={() => {
              queryClient.invalidateQueries({ queryKey: ['messages', activeAccountId, folderPath] });
              queryClient.invalidateQueries({ queryKey: ['folders', activeAccountId] });
            }}
            onClosed={() => setSelected(null)}
            ownEmail={currentAccount?.email ?? null}
          />
        )}
        </div>
      </div>

      {/*
        The windows layer: composers, the theme picker and the dialog boxes,
        stacked among themselves by lib/windows.ts, under the send toast.
        It lets clicks through except on the windows themselves.
      */}
      <div className="mf-windows pointer-events-none fixed inset-0 z-40">
        {composers.map(({ key, draft, account, cascade }) => (
          <Composer
            key={key}
            windowId={`composer-${key}`}
            cascade={cascade}
            account={account}
            draft={draft}
            onClose={() => closeComposer(key)}
            onSent={() => {
              closeComposer(key);
              queryClient.invalidateQueries({ queryKey: ['messages', account.id] });
            }}
            onSendActivity={reportSend}
          />
        ))}

        {themesOpen && <ThemeModal onClose={() => setThemesOpen(false)} />}

        {accountsOpen && (
          <AccountsWindow
            onClose={() => setAccountsOpen(false)}
            onAdded={(account) => {
              setAccountsOpen(false);
              setAccountId(account.id);
              setFolderPath('INBOX');
              setSelected(null);
              setFolderSyncing(true);
            }}
          />
        )}

        <DialogHost />
      </div>

      {sendToast && <SendToast state={sendToast} onDismiss={dismissSendToast} />}

      <Taskbar />
    </div>
  );
}

/**
 * Les deux écrans où l'app ne peut pas s'afficher. Ils sont bâtis comme les
 * autres fenêtres — barre de titre, zone cliente — pour que chaque thème les
 * dessine avec les mêmes crochets, au lieu d'une carte qu'aucun ne connaît.
 */
function StandaloneWindow({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="mf-stage flex h-full items-center justify-center overflow-y-auto bg-canvas p-8">
      <div
        className={cn(
          'mf-window flex max-h-full flex-col overflow-hidden rounded-lg border border-line bg-surface',
          wide ? 'w-[min(40rem,100%)]' : 'max-w-md',
        )}
      >
        <div className="mf-window-title flex shrink-0 items-center border-b border-line px-4 py-3">
          <span className="text-sm font-medium">{APP_NAME}</span>
        </div>
        <div className="mf-window-body min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/**
 * First run: no account anywhere, neither in `.env` nor added here. Says in
 * three lines what mailFlow is, then hands over to the same form as the
 * accounts window. Once the account is added, the accounts query refreshes
 * and the app takes the place of this screen.
 */
function Welcome() {
  const queryClient = useQueryClient();
  return (
    <StandaloneWindow wide>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-base font-semibold">Bienvenue dans {APP_NAME}</h1>
          <p className="text-sm leading-relaxed text-ink-muted">
            {APP_NAME} lit et envoie votre courrier depuis cet ordinateur, en se connectant
            directement à la boîte de votre fournisseur. Vos mails restent chez lui : {APP_NAME} en
            garde seulement une copie locale pour s’afficher vite et chercher hors ligne.
          </p>
          <p className="text-sm leading-relaxed text-ink-muted">
            Les images et contenus distants d’un mail ne se chargent qu’à votre demande, pour
            qu’aucun expéditeur ne sache que vous l’avez ouvert.
          </p>
        </div>
        <div className="border-t border-line pt-4">
          <h2 className="mb-3 text-sm font-medium">Ajouter votre premier compte</h2>
          <AccountSetup
            onDone={() => void queryClient.invalidateQueries({ queryKey: ['accounts'] })}
          />
        </div>
      </div>
    </StandaloneWindow>
  );
}

function NeedsConsent({
  account,
  others,
  onSwitch,
}: {
  account: Account;
  others: Account[];
  onSwitch: (id: string) => void;
}) {
  const google = account.provider === 'google';
  // The consent runs elsewhere (a popup, or the system browser for the desktop
  // app): watching the account is what brings this screen to an end.
  useQuery({ queryKey: ['accounts'], queryFn: api.accounts, refetchInterval: 2000 });
  return (
    <StandaloneWindow>
      <div className="p-6 text-center">
        <h1 className="text-base font-semibold">Connexion à {account.email}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {google
            ? 'Google demande votre accord avant que mailFlow puisse lire et envoyer vos mails. Autorisez-le une fois : l’accès se renouvelle ensuite tout seul.'
            : "Microsoft n'accepte plus les mots de passe pour l'accès IMAP. Autorisez mailFlow une fois : le jeton se renouvelle ensuite tout seul."}
        </p>
        <a
          href={`/api/accounts/${encodeURIComponent(account.id)}/oauth`}
          className="mf-btn-primary mt-5 inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90"
        >
          {google ? 'Autoriser avec Google' : 'Autoriser avec Microsoft'}
        </a>
        <p className="mt-4 text-xs text-ink-muted">
          {IN_DESKTOP_APP
            ? 'La connexion s’ouvre dans votre navigateur. Cette fenêtre se mettra à jour dès que l’accès sera accordé.'
            : "Rechargez cette page une fois l'autorisation accordée."}
        </p>
        {others.length > 0 && (
          <div className="mt-5 flex flex-col items-center gap-2 border-t border-line pt-4">
            <p className="text-xs text-ink-muted">Ou revenir à un autre compte :</p>
            {others.map((other) => (
              <button
                key={other.id}
                type="button"
                onClick={() => onSwitch(other.id)}
                className="mf-btn cursor-pointer rounded-md border border-line px-4 py-1.5 text-sm hover:bg-surface-hover"
              >
                {other.label} ({other.email})
              </button>
            ))}
          </div>
        )}
      </div>
    </StandaloneWindow>
  );
}

function FatalError({ message }: { message: string }) {
  return (
    <StandaloneWindow>
      <div className="flex gap-3 p-5">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-warn" />
        <p className="text-sm leading-relaxed text-ink-muted">{message}</p>
      </div>
    </StandaloneWindow>
  );
}
