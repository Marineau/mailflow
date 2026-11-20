import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Ban,
  Download,
  EyeOff,
  FolderDown,
  Forward,
  ImageOff,
  Lightbulb,
  LightbulbOff,
  Loader2,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldOff,
  Star,
  Trash2,
  X,
} from './icons';
import { api, type FullMessage, type MessageSummary, type SpamResult } from '../lib/api';
import { alertDialog, confirmDialog } from '../lib/dialog';
import { useAppearance } from '../lib/theme';
import { cn, formatFullDate, formatParty, formatSize, initials, recipientsLabel, senderAddress } from '../lib/utils';
import MailBody from './MailBody';
import {
  createDownloadFolder,
  directoryPicker,
  isPickerCancel,
  vacantFileName,
  writeBlob,
} from '../lib/saveFolder';
import { MessageBodySkeleton } from './Loader';

const DARK_MAIL_KEY = 'mailflow.dark-message';

function readDarkMail(): boolean {
  try {
    return localStorage.getItem(DARK_MAIL_KEY) !== '0';
  } catch {
    return true;
  }
}

interface Props {
  accountId: string | null;
  summary: MessageSummary | null;
  /** Termes de la recherche en cours, surlignés dans le corps du mail. */
  highlight: string;
  onReply: (message: FullMessage, replyAll: boolean) => void;
  onForward: (message: FullMessage) => void;
  /** Toggles \Flagged ("important"), shared with the list's hover action. */
  onToggleImportant: (message: MessageSummary) => void;
  onChanged: () => void;
  onClosed: () => void;
  /** Envoyés et brouillons : l'identité affichée est le destinataire. */
  isOutbound: (folder: string) => boolean;
  /** Adresse du compte, pour ne pas proposer de se bloquer soi-même. */
  ownEmail: string | null;
}

/** The message an action was asked about, fixed when its button is clicked. */
interface Target {
  account: string;
  folder: string;
  uid: number;
}

export default function MessageView({
  accountId,
  summary,
  highlight,
  onReply,
  onForward,
  onToggleImportant,
  onChanged,
  onClosed,
  isOutbound,
  ownEmail,
}: Props) {
  const queryClient = useQueryClient();
  const [showImages, setShowImages] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Le résumé dans la liste ne se met à jour qu'au prochain chargement. Le bouton,
  // lui, doit changer tout de suite.
  const [blockedOverride, setBlockedOverride] = useState<boolean | null>(null);
  // En mode sombre, le corps du mail arrive quand même avec ses propres
  // couleurs : on les remappe, et on garde un retour vers l'original.
  // En mode clair il n'y a rien à remapper : le mail s'affiche tel quel, et la
  // préférence attend le retour du mode sombre.
  const { mode } = useAppearance();
  const [darkMailPref, setDarkMail] = useState(readDarkMail);
  const darkMail = mode === 'dark' && darkMailPref;

  const folder = summary?.folder ?? '';
  const uid = summary?.uid ?? 0;
  // Dialogs are not modal: a confirmation can be answered after another mail
  // was opened. Actions therefore take the message they were asked about as a
  // variable, and only touch the reader if that message is still the one shown.
  const shown = useRef({ folder, uid });
  shown.current = { folder, uid };
  const stillShown = (target: Target) =>
    shown.current.folder === target.folder && shown.current.uid === target.uid;

  const messageQuery = useQuery({
    queryKey: ['message', accountId, folder, uid],
    queryFn: () => api.message(accountId as string, folder, uid),
    enabled: Boolean(accountId && summary),
    // Le corps d'un mail est immuable : ce que le préchargement a mis en cache
    // sert tel quel, sans requête de revalidation. `gcTime` le lâche ensuite,
    // sinon chaque mail ouvert resterait en mémoire pour la session.
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });

  // Chaque mail repart images bloquées : une autorisation ne vaut que pour celui
  // qu'on vient d'ouvrir.
  useEffect(() => {
    setShowImages(false);
    setNotice(null);
    setBlockedOverride(null);
  }, [folder, uid]);

  const markSeen = useMutation({
    mutationFn: () => api.setFlags(accountId as string, folder, uid, ['\\Seen'], []),
    onSuccess: onChanged,
  });

  useEffect(() => {
    if (summary && !summary.seen && accountId) markSeen.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, folder, uid]);

  const remove = useMutation({
    mutationFn: (target: Target) => api.remove(target.account, target.folder, target.uid),
    onSuccess: (_result, target) => {
      onChanged();
      if (stillShown(target)) onClosed();
    },
  });

  const reportSpam = useMutation({
    mutationFn: (target: Target) => api.reportSpam(target.account, target.folder, target.uid),
    onSuccess: (result, target) => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ['messages', accountId] });
      void queryClient.invalidateQueries({ queryKey: ['blocked', accountId] });
      void queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
      const text = spamFeedback(result);
      // Déplacé vers Banned ou masqué dans les indésirables : dans les deux cas
      // le message a quitté la liste, le lecteur n'a plus rien à montrer.
      const gone = result.moved || Boolean(result.hidden);
      // Another mail is open by now: say what happened instead of writing it
      // into that mail's reader.
      if (!stillShown(target)) {
        if (result.warning || !gone) void alertDialog({ title: 'Expéditeur bloqué', message: text });
        return;
      }
      setBlockedOverride(true);
      if (gone && !result.warning) {
        onClosed();
        return;
      }
      if (gone) {
        onClosed();
        void alertDialog({ title: 'Expéditeur bloqué', message: text });
        return;
      }
      setNotice(text);
    },
    onError: (err: Error) =>
      void alertDialog({ title: 'Signalement impossible', message: err.message }),
  });

  const unblock = useMutation({
    mutationFn: ({ account, email }: { account: string; email: string; target: Target }) =>
      api.unblockSender(account, email),
    onSuccess: (_result, { email, target }) => {
      if (stillShown(target)) {
        setBlockedOverride(false);
        setNotice(
          `${email} est débloqué. Les messages rangés dans Banned y restent ; ceux qui étaient masqués dans les indésirables réapparaissent.`,
        );
      }
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ['messages', accountId] });
      void queryClient.invalidateQueries({ queryKey: ['blocked', accountId] });
    },
    onError: (err: Error) =>
      void alertDialog({ title: 'Déblocage impossible', message: err.message }),
  });

  const message = messageQuery.data;

  if (!summary) {
    return (
      <div className="mf-reader mf-reader-empty flex flex-1 items-center justify-center text-sm text-ink-muted">
        Sélectionnez un message.
      </div>
    );
  }

  const outbound = isOutbound(summary.folder);
  const toPeople = message?.to?.length ? message.to : summary.to;
  const ccPeople = message?.cc ?? [];
  const address = senderAddress(summary.from.address);
  const own = ownEmail?.trim().toLowerCase() ?? '';
  const canBlock = Boolean(address) && !outbound && address !== own;
  const senderBlocked = blockedOverride ?? Boolean(summary.senderBlocked);
  const spamBusy = reportSpam.isPending || unblock.isPending;

  return (
    <div className="mf-reader flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="mf-reader-head flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="mf-avatar flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold">
          {initials(outbound ? (toPeople[0] ?? { name: '?' }) : summary.from)}
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="mf-heading truncate text-base font-semibold">{summary.subject}</h1>
          {outbound ? (
            <>
              <p className="truncate text-sm text-ink">À {recipientsLabel(toPeople)}</p>
              {ccPeople.length > 0 && (
                <p className="truncate text-sm text-ink-muted">Cc {recipientsLabel(ccPeople)}</p>
              )}
              <p className="truncate text-sm text-ink-muted">De {formatParty(summary.from)}</p>
            </>
          ) : (
            <p className="truncate text-sm text-ink-muted">{formatParty(summary.from)}</p>
          )}
          <p className="text-xs text-ink-muted">{formatFullDate(summary.date)}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            title="Répondre"
            onClick={() => message && onReply(message, false)}
            icon={<Reply className="size-4" />}
          />
          <IconButton
            title="Répondre à tous"
            onClick={() => message && onReply(message, true)}
            icon={<ReplyAll className="size-4" />}
          />
          <IconButton
            title="Transférer"
            onClick={() => message && onForward(message)}
            icon={<Forward className="size-4" />}
          />
          <IconButton
            title={summary.flagged ? "Retirer l'importance" : 'Marquer comme important'}
            onClick={() => onToggleImportant(summary)}
            icon={
              <Star
                data-on={summary.flagged || undefined}
                className={cn('size-4', summary.flagged && 'fill-flag text-flag')}
              />
            }
          />
          <IconButton
            title="Marquer non lu"
            onClick={() =>
              accountId && api.setFlags(accountId, folder, uid, [], ['\\Seen']).then(onChanged)
            }
            icon={<EyeOff className="size-4" />}
          />
          {canBlock && address && (
            <IconButton
              title={
                senderBlocked
                  ? 'Signaler comme indésirable'
                  : 'Bloquer et signaler comme indésirable'
              }
              disabled={spamBusy}
              onClick={() => {
                if (!accountId) return;
                const target: Target = { account: accountId, folder, uid };
                void confirmDialog(
                  senderBlocked
                    ? {
                        title: 'Signaler comme indésirable',
                        message: `${address} est déjà bloqué.\n\nSignaler quand même ce message comme indésirable ?`,
                        confirmLabel: 'Signaler',
                      }
                    : {
                        title: "Bloquer l'expéditeur",
                        message: `Bloquer ${address} et signaler ce message comme indésirable ?\n\nLes prochains messages de cette adresse iront dans Banned. Ceux que la boîte classe dans les indésirables y restent, sans être affichés.`,
                        confirmLabel: 'Bloquer et signaler',
                      },
                ).then((confirmed) => {
                  if (confirmed) reportSpam.mutate(target);
                });
              }}
              icon={
                spamBusy && !unblock.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Ban className={cn('size-4', senderBlocked && 'text-warn')} />
                )
              }
            />
          )}
          {canBlock && address && senderBlocked && (
            <IconButton
              title="Débloquer l'expéditeur"
              disabled={spamBusy}
              onClick={() => {
                if (!accountId) return;
                const target: Target = { account: accountId, folder, uid };
                void confirmDialog({
                  title: "Débloquer l'expéditeur",
                  message: `Débloquer ${address} ?\n\nLes messages rangés dans Banned y restent, les suivants ne seront plus déplacés. Ceux qui étaient masqués dans les indésirables réapparaissent.`,
                  confirmLabel: 'Débloquer',
                }).then((confirmed) => {
                  if (confirmed) unblock.mutate({ account: target.account, email: address, target });
                });
              }}
              icon={
                unblock.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldOff className="size-4" />
                )
              }
            />
          )}
          <IconButton
            title="Archiver"
            onClick={() => {
              if (!accountId) return;
              const target: Target = { account: accountId, folder, uid };
              api
                .move(target.account, target.folder, target.uid, 'Archive')
                .then(() => {
                  onChanged();
                  if (stillShown(target)) onClosed();
                })
                .catch(
                  (err: Error) =>
                    void alertDialog({ title: 'Archivage impossible', message: err.message }),
                );
            }}
            icon={<Archive className="size-4" />}
          />
          <IconButton
            title="Supprimer"
            onClick={() => {
              if (!accountId) return;
              const target: Target = { account: accountId, folder, uid };
              void confirmDialog({
                title: 'Supprimer le message',
                message: 'Supprimer définitivement ce message ?',
                confirmLabel: 'Supprimer',
                danger: true,
              }).then((confirmed) => {
                if (confirmed) remove.mutate(target);
              });
            }}
            icon={<Trash2 className="size-4" />}
          />
          {/* Soleil et lune sont pris par le mode de l'app, dans la barre du haut :
              ici c'est la lampe du message, et seulement quand il fait sombre. */}
          {mode === 'dark' && (
            <IconButton
              title={darkMail ? 'Afficher le message en clair' : 'Assombrir le message'}
              pressed={darkMail}
              onClick={() => {
                setDarkMail((value) => {
                  const next = !value;
                  try {
                    localStorage.setItem(DARK_MAIL_KEY, next ? '1' : '0');
                  } catch {
                    /* mode privé : le choix vit le temps de l'onglet */
                  }
                  return next;
                });
              }}
              icon={
                darkMail ? <Lightbulb className="size-4" /> : <LightbulbOff className="size-4" />
              }
            />
          )}
          <IconButton title="Fermer" onClick={onClosed} icon={<X className="size-4" />} />
        </div>
      </div>

      {notice && (
        <div className="mf-infobar flex items-start gap-3 border-b border-line bg-surface px-5 py-2.5 text-sm text-ink-muted">
          <Ban className="mt-0.5 size-4 shrink-0 text-warn" />
          <span>{notice}</span>
        </div>
      )}

      {message && message.blockedImages > 0 && !showImages && (
        <div className="mf-infobar flex items-center gap-3 border-b border-line bg-surface px-5 py-2.5 text-sm">
          <ImageOff className="size-4 shrink-0 text-ink-muted" />
          <span className="text-ink-muted">
            {/* Images, mais aussi fonds, feuilles et polices nommés dans le CSS. */}
            {message.blockedImages > 1
              ? `${message.blockedImages} éléments distants bloqués — les afficher`
              : "1 élément distant bloqué — l'afficher"}{' '}
            signale votre lecture à l'expéditeur.
          </span>
          <button
            type="button"
            onClick={() => setShowImages(true)}
            className="mf-btn ml-auto shrink-0 rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface-hover"
          >
            Afficher
          </button>
        </div>
      )}

      {message && (
        <AttachmentBar
          messageKey={`${message.account}\0${message.folder}\0${message.uid}`}
          attachments={message.attachments}
          folderName={message.subject || summary.subject}
          hrefFor={(index) => api.attachmentUrl(accountId as string, folder, uid, index)}
        />
      )}

      {messageQuery.isLoading && <MessageBodySkeleton />}
      {messageQuery.isError && (
        <p className="p-5 text-sm text-warn">{(messageQuery.error as Error).message}</p>
      )}

      {message && (
        <MailBody
          html={message.html}
          text={message.text}
          dark={darkMail}
          highlight={highlight}
          showRemoteImages={showImages}
          attachments={message.attachments}
          urlFor={(index) => api.attachmentUrl(accountId as string, folder, uid, index)}
        />
      )}
    </div>
  );
}

function AttachmentBar({
  messageKey,
  attachments,
  folderName,
  hrefFor,
}: {
  /** Compte, dossier et UID du mail ouvert. Le cache des octets en dépend. */
  messageKey: string;
  attachments: FullMessage['attachments'];
  folderName: string;
  hrefFor: (index: number) => string;
}) {
  const files = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(
      ({ attachment }) =>
        !(attachment.cid && attachment.contentType.toLowerCase().startsWith('image/')),
    );
  const jobs = useRef(new Map<string, Promise<Blob>>());
  const ready = useRef(new Map<string, Blob>());
  // Un téléchargement lancé pour le mail précédent ne doit pas remplir le cache
  // du mail affiché : deux messages ont souvent une pièce jointe au même index.
  const generation = useRef(0);
  const savingAll = useRef(false);
  const [phase, setPhase] = useState<Record<number, 'loading' | 'ready' | 'error'>>({});
  const [writing, setWriting] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [trackedKey, setTrackedKey] = useState(messageKey);
  if (trackedKey !== messageKey) {
    setTrackedKey(messageKey);
    setPhase({});
    setSaveNotice(null);
  }

  function slot(index: number): string {
    return `${messageKey}:${index}`;
  }

  function load(index: number): Promise<Blob> {
    const key = slot(index);
    const cached = ready.current.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = jobs.current.get(key);
    if (pending) return pending;

    const ticket = generation.current;
    setPhase((current) => ({ ...current, [index]: 'loading' }));
    const job = fetch(hrefFor(index))
      .then(async (response) => {
        if (!response.ok) throw new Error('Téléchargement impossible');
        const blob = await response.blob();
        if (jobs.current.get(key) === job) jobs.current.delete(key);
        if (ticket !== generation.current) return blob;
        ready.current.set(key, blob);
        setPhase((current) => ({ ...current, [index]: 'ready' }));
        return blob;
      })
      .catch((error: unknown) => {
        if (jobs.current.get(key) === job) jobs.current.delete(key);
        if (ticket === generation.current) {
          setPhase((current) => ({ ...current, [index]: 'error' }));
        }
        throw error;
      });
    jobs.current.set(key, job);
    return job;
  }

  useEffect(() => {
    generation.current += 1;
    jobs.current.clear();
    ready.current.clear();
  }, [messageKey]);

  async function save(index: number, filename: string) {
    const blob = await load(index);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function saveAll() {
    if (savingAll.current) return;
    const choose = directoryPicker();
    if (!choose) {
      setSaveNotice({ tone: 'error', text: 'Ce navigateur ne peut pas créer de dossier.' });
      return;
    }
    savingAll.current = true;
    setWriting(true);
    setSaveNotice(null);
    try {
      const parent = await choose({
        mode: 'readwrite',
        id: 'mailflow-attachments',
        startIn: 'downloads',
      });
      const { folder, createdName } = await createDownloadFolder(parent, folderName);
      const reserved = new Set<string>();
      let failed = 0;
      for (const file of files) {
        try {
          const blob = await load(file.index);
          const name = await vacantFileName(folder, file.attachment.filename || 'piece-jointe', reserved);
          await writeBlob(folder, name, blob);
        } catch {
          failed += 1;
        }
      }
      if (failed === 0) {
        setSaveNotice({
          tone: 'ok',
          text: `${files.length} fichiers dans « ${createdName} ».`,
        });
      } else if (failed === files.length) {
        setSaveNotice({ tone: 'error', text: 'Aucun fichier enregistré.' });
      } else {
        setSaveNotice({
          tone: 'error',
          text: `${failed} fichier${failed > 1 ? 's' : ''} non enregistré${failed > 1 ? 's' : ''}.`,
        });
      }
    } catch (error) {
      if (!isPickerCancel(error)) {
        setSaveNotice({ tone: 'error', text: 'Enregistrement impossible.' });
      }
    } finally {
      savingAll.current = false;
      setWriting(false);
    }
  }

  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
      <span className="text-xs text-ink-muted">
        Pièce{files.length > 1 ? 's' : ''} jointe{files.length > 1 ? 's' : ''}
      </span>
      {files.length > 1 && (
        <button
          type="button"
          title="Créer un dossier et y enregistrer toutes les pièces jointes"
          disabled={writing}
          onClick={() => {
            void saveAll();
          }}
          className="mf-btn flex items-center gap-2 rounded-md border border-accent/40 bg-surface px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-60"
        >
          {writing ? (
            <Loader2 className="size-3.5 animate-spin text-ink-muted" />
          ) : (
            <FolderDown className="size-3.5 text-ink-muted" />
          )}
          {writing ? 'Enregistrement…' : 'Tout enregistrer'}
        </button>
      )}
      {files.map(({ attachment, index }) => {
        const state = phase[index];
        return (
          <button
            key={`${attachment.filename}-${index}`}
            type="button"
            onClick={() => {
              void save(index, attachment.filename).catch(() => undefined);
            }}
            className="mf-btn flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-60"
          >
            <Paperclip className="size-3.5 text-ink-muted" />
            <span className="max-w-56 truncate">{attachment.filename}</span>
            <span className="text-ink-muted">{formatSize(attachment.size)}</span>
            {state === 'loading' ? (
              <Loader2 className="size-3.5 animate-spin text-ink-muted" />
            ) : (
              <Download className="size-3.5 text-ink-muted" />
            )}
            {state === 'loading' ? 'Préparation…' : state === 'error' ? 'Échec' : 'Télécharger'}
          </button>
        );
      })}
      {saveNotice && (
        <span className={cn('text-xs', saveNotice.tone === 'error' ? 'text-warn' : 'text-ink-muted')}>
          {saveNotice.text}
        </span>
      )}
    </div>
  );
}

function spamFeedback(result: SpamResult): string {
  if (result.warning) return `${result.email} est bloqué. ${result.warning}`;
  if (result.hidden) {
    return result.submitted
      ? `${result.email} est bloqué. Le message reste dans les indésirables, où il n'est plus affiché ; le signalement a été envoyé à Microsoft.`
      : `${result.email} est bloqué. Le message reste dans les indésirables, où il n'est plus affiché.`;
  }
  if (result.submitted && result.alreadyInBanned) {
    return `${result.email} est bloqué. Le message était déjà dans Banned ; le signalement a été envoyé à Microsoft.`;
  }
  if (result.submitted) {
    return `${result.email} est bloqué. Le signalement a été envoyé à Microsoft.`;
  }
  if (result.alreadyInBanned) {
    return `${result.email} est bloqué. Le message était déjà dans Banned.`;
  }
  return `${result.email} est bloqué.`;
}

function IconButton({
  title,
  onClick,
  icon,
  pressed,
  disabled,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'mf-icon-btn rounded-md p-2 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40',
        pressed && 'text-ink',
      )}
    >
      {icon}
    </button>
  );
}

