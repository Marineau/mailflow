import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Ban,
  Check,
  Database,
  FileText,
  Folder as FolderIcon,
  Inbox,
  Loader2,
  Send,
  ShieldAlert,
  ShieldOff,
  Trash2,
} from './icons';
import { api, type Account } from '../lib/api';
import { confirmDialog } from '../lib/dialog';
import type { IndexProgress } from '../App';
import { cn, folderLabel, indexKey } from '../lib/utils';
import { FolderListSkeleton } from './Loader';
import ProgressFill from './ProgressFill';
import { reportProgress } from '../lib/progress';

interface Props {
  accounts: Account[];
  accountId: string | null;
  folderPath: string;
  onSelectAccount: (id: string) => void;
  onSelectFolder: (path: string) => void;
  indexing: Record<string, IndexProgress>;
  folderPathForIndex: string;
}

/**
 * À quoi sert un dossier. Écrit sur la ligne en `data-kind` : un thème colore
 * une icône d'après ce qu'elle désigne, pas d'après le nom de classe que la
 * bibliothèque d'icônes lui donne ce mois-ci.
 */
type FolderKind = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'banned' | 'trash' | 'folder';

const KIND_BY_SPECIAL_USE: Record<string, FolderKind> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
};

const ICONS: Record<FolderKind, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  archive: Archive,
  junk: ShieldAlert,
  banned: Ban,
  trash: Trash2,
  folder: FolderIcon,
};

function folderKind(folder: { path: string; name: string; specialUse: string | null }): FolderKind {
  if (folder.name.trim().toLowerCase() === 'banned') return 'banned';
  if (folder.path.toUpperCase() === 'INBOX') return 'inbox';
  return KIND_BY_SPECIAL_USE[folder.specialUse ?? ''] ?? 'folder';
}

/** Les boîtes spéciales passent devant : c'est là qu'on va 95 % du temps. */
const ORDER = ['INBOX', '\\Sent', '\\Drafts', '\\Archive', '\\Junk', 'BANNED', '\\Trash'];

export default function Sidebar({
  accounts,
  accountId,
  folderPath,
  onSelectAccount,
  onSelectFolder,
  indexing,
  folderPathForIndex,
}: Props) {
  const queryClient = useQueryClient();
  const foldersQuery = useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => api.folders(accountId as string),
    enabled: Boolean(accountId),
  });
  const blockedQuery = useQuery({
    queryKey: ['blocked', accountId],
    queryFn: () => api.blockedSenders(accountId as string),
    enabled: Boolean(accountId),
  });
  const unblock = useMutation({
    // The account is fixed at click time: the confirmation may be answered
    // after another account was selected.
    mutationFn: ({ account, email }: { account: string; email: string }) =>
      api.unblockSender(account, email),
    onSuccess: (_result, { account }) => {
      void queryClient.invalidateQueries({ queryKey: ['blocked', account] });
      void queryClient.invalidateQueries({ queryKey: ['messages', account] });
    },
  });

  const folderPaths = (foldersQuery.data ?? []).map((folder) => folder.path);
  const folders = [...(foldersQuery.data ?? [])].sort((a, b) => {
    const rank = (f: typeof a) => {
      if (f.name.trim().toLowerCase() === 'banned') return ORDER.indexOf('BANNED');
      const key = f.path.toUpperCase() === 'INBOX' ? 'INBOX' : (f.specialUse ?? '');
      const index = ORDER.indexOf(key);
      return index === -1 ? ORDER.length : index;
    };
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });

  return (
    // Le pied reste visible quoi qu'il arrive : c'est le seul point d'entrée de
    // l'indexation, il ne doit pas se perdre sous seize dossiers.
    <nav className="mf-nav flex w-60 shrink-0 flex-col gap-4 border-r border-line p-3">
      {accounts.length > 1 && (
        <div className="flex flex-col gap-1">
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => onSelectAccount(account.id)}
              aria-current={account.id === accountId ? 'true' : undefined}
              className={cn(
                'mf-nav-item rounded-md px-3 py-2 text-left text-sm transition-colors',
                account.id === accountId
                  ? 'bg-surface font-medium'
                  : 'text-ink-muted hover:bg-surface-hover',
              )}
            >
              <span className="block truncate">{account.label}</span>
              <span className="block truncate text-xs text-ink-muted">{account.email}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {(!accountId || foldersQuery.isLoading) && <FolderListSkeleton />}

        {folders.map((folder) => {
          const kind = folderKind(folder);
          const Icon = ICONS[kind];
          const active = folder.path === folderPath;

          return (
            <button
              key={folder.path}
              type="button"
              onClick={() => onSelectFolder(folder.path)}
              aria-current={active ? 'true' : undefined}
              data-kind={kind}
              className={cn(
                'mf-nav-item flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                active ? 'bg-surface font-medium' : 'text-ink-muted hover:bg-surface-hover',
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{folderLabel(folder)}</span>
              {folder.unseen > 0 && (
                <span className="mf-badge shrink-0 rounded-full bg-accent/15 px-1.5 text-xs font-medium text-accent">
                  {folder.unseen}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {accountId && (blockedQuery.data?.length ?? 0) > 0 && (
        <div className="flex max-h-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-t border-line pt-3">
          <p className="px-2 pb-1 text-xs font-medium text-ink-muted">Expéditeurs bloqués</p>
          {blockedQuery.data?.map((sender) => (
            <div key={sender.email} className="flex items-center gap-1 rounded-md px-2 py-1">
              <Ban className="size-3.5 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 truncate text-xs" title={sender.email}>
                {sender.email}
              </span>
              <button
                type="button"
                title={`Débloquer ${sender.email}`}
                disabled={unblock.isPending}
                onClick={() => {
                  const account = accountId;
                  void confirmDialog({
                    title: "Débloquer l'expéditeur",
                    message: `Débloquer ${sender.email} ?\n\nLes messages rangés dans Banned y restent. Ceux qui étaient masqués dans les indésirables réapparaissent.`,
                    confirmLabel: 'Débloquer',
                  }).then((confirmed) => {
                    if (confirmed) unblock.mutate({ account, email: sender.email });
                  });
                }}
                className="mf-icon-btn rounded-md p-1 text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-40"
              >
                <ShieldOff className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {accountId && (
        <IndexPanel
          accountId={accountId}
          folderPath={folderPathForIndex}
          folderPaths={folderPaths}
          indexing={indexing}
        />
      )}
    </nav>
  );
}

/**
 * Pilotage de l'indexation. Explicite plutôt qu'automatique : rapatrier
 * 24 000 corps de mails est un travail long, c'est à l'utilisateur de le lancer.
 */
function IndexPanel({
  accountId,
  folderPath,
  folderPaths,
  indexing,
}: {
  accountId: string;
  folderPath: string;
  /** Every folder of the account, for the « whole mailbox » level. */
  folderPaths: string[];
  indexing: Record<string, IndexProgress>;
}) {
  const stateOf = (path: string) => indexing[indexKey(accountId, path)];
  const progress = stateOf(folderPath) ?? null;
  const queryClient = useQueryClient();

  const start = useMutation({
    mutationFn: (scope: 'folder' | 'all') =>
      api.startIndex(accountId, scope === 'folder' ? folderPath : undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages', accountId] }),
  });

  const cancel = useMutation({
    mutationFn: (path: string) => api.cancelIndex(accountId, path),
  });

  // Folders of this account under way; the map also holds other accounts' folders.
  const running = folderPaths.filter((path) => isActive(stateOf(path)));
  const folderActive = isActive(progress);
  // The button that started the work fills. A job found under way (resumed at
  // start-up) is shown on « Indexer ce dossier » if it is this folder's.
  const [startedScope, setStartedScope] = useState<'folder' | 'all' | null>(null);
  const scope: 'folder' | 'all' | null =
    startedScope === 'all' && running.length > 0 ? 'all' : folderActive ? 'folder' : null;
  const busy = scope !== null;

  // Real level of the job, as checkpoints for the fill.
  const opKey = `index:${accountId}:${scope === 'all' ? '*' : folderPath}`;
  const level =
    scope === 'all'
      ? folderPaths.reduce((sum, path) => sum + indexShare(stateOf(path)), 0) /
        Math.max(1, folderPaths.length)
      : indexShare(progress);
  const previousLevel = useRef(0);
  useEffect(() => {
    if (!busy) {
      previousLevel.current = 0;
      return;
    }
    // The next checkpoint is assumed one more step of the size of the last one.
    const step = Math.max(level - previousLevel.current, 0.001);
    reportProgress(opKey, level, Math.min(1, level + step));
    previousLevel.current = level;
  }, [busy, level, opKey]);

  const doneFolders = folderPaths.filter((path) => indexShare(stateOf(path)) >= 1).length;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-line pt-3 text-xs">
      {!busy && progress?.phase === 'done' && (
        <span className="flex items-center gap-1.5 text-ink-muted">
          <Check className="size-3.5" /> Dossier indexé
        </span>
      )}
      {!busy && progress?.phase === 'error' && (
        <span className="text-warn">{progress.message ?? 'Indexation interrompue'}</span>
      )}

      <button
        type="button"
        onClick={() => {
          setStartedScope('folder');
          start.mutate('folder');
        }}
        disabled={start.isPending || busy}
        aria-busy={scope === 'folder'}
        className={cn(
          'mf-icon-btn relative isolate flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink',
          scope !== 'folder' && 'disabled:opacity-40',
        )}
      >
        <ProgressFill op={opKey} running={scope === 'folder'} kind="index" />
        {scope === 'folder' && progress ? (
          <>
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">
              {progress.phase === 'headers' ? 'En-têtes' : 'Corps des mails'} —{' '}
              {progress.done.toLocaleString('fr-FR')} / {progress.total.toLocaleString('fr-FR')}
            </span>
          </>
        ) : (
          <>
            <Database className="size-3.5 shrink-0" />
            Indexer ce dossier
          </>
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          setStartedScope('all');
          start.mutate('all');
        }}
        disabled={start.isPending || busy}
        aria-busy={scope === 'all'}
        className={cn(
          'mf-icon-btn relative isolate flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink',
          scope !== 'all' && 'disabled:opacity-40',
        )}
      >
        <ProgressFill op={opKey} running={scope === 'all'} kind="index" />
        {scope === 'all' ? (
          <>
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">
              Boîte entière — {doneFolders} / {folderPaths.length} dossiers
            </span>
          </>
        ) : (
          <>
            <Database className="size-3.5 shrink-0" />
            Indexer toute la boîte
          </>
        )}
      </button>

      {busy && (
        <button
          type="button"
          onClick={() => {
            for (const path of scope === 'all' ? running : [folderPath]) cancel.mutate(path);
          }}
          className="mf-icon-btn -ml-2 self-start rounded-md px-2 py-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Arrêter
        </button>
      )}
    </div>
  );
}

function isActive(progress: IndexProgress | null | undefined): boolean {
  return progress?.phase === 'headers' || progress?.phase === 'bodies';
}

/**
 * How far a folder's indexing is, 0 to 1. The header pass is short (about
 * 5 minutes for 28 000 mails) next to the body pass (about 30), hence its
 * smaller share.
 */
function indexShare(progress: IndexProgress | null | undefined): number {
  if (!progress) return 0;
  const ratio = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  switch (progress.phase) {
    case 'headers':
      return 0.15 * ratio;
    case 'bodies':
      return 0.15 + 0.85 * ratio;
    case 'done':
    case 'error':
      return 1;
    default:
      return 0;
  }
}
