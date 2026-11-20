import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import { GripHorizontal, Loader2, Paperclip, PenSquare, Send, X } from './icons';
import WindowControls from './WindowControls';
import WindowResize from './WindowResize';
import { useWindowDrag } from '../lib/useWindowDrag';
import { confirmDialog } from '../lib/dialog';
import { restoreWindow, useManagedWindow } from '../lib/windows';
import { api, type Account, type Sender } from '../lib/api';
import type { SendActivity } from './SendToast';
import ComposerToolbar from './ComposerToolbar';
import ProgressFill from './ProgressFill';
import { newOpId, reportProgress } from '../lib/progress';
import {
  fileForClipboardImage,
  filesFromClipboard,
  isInlineImageType,
  serializeDoc,
} from '../lib/composeBody';
import {
  composeExtensions,
  inlineImageIds,
  insertPlainText,
  placeCaretAt,
  textToDoc,
} from '../lib/composeEditor';
import { cn, formatSize } from '../lib/utils';

const EDITOR_PLACEHOLDER = "Votre message… Collez une capture d'écran avec Ctrl+V.";

/** Below this the address fields and the send button no longer fit. */
const MIN_WINDOW_WIDTH = 416;
/** Title, the three fields, a wrapped toolbar, a few lines of text, and the send bar. */
const MIN_WINDOW_HEIGHT = 448;

/** Mêmes plafonds que `parseOutgoingAttachments` côté serveur. */
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

interface PendingFile {
  id: string;
  file: File;
  /** Capture collée dans le texte. Le même fichier est listé avec les pièces jointes. */
  inline: boolean;
  previewUrl?: string;
}

export interface DraftFile {
  filename: string;
  contentType: string;
  url: string;
}

export interface ComposerDraft {
  kind: 'new' | 'reply' | 'forward';
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  /** Pièces jointes déjà sur le serveur, reprises pour un transfert. */
  files?: DraftFile[];
}

interface Props {
  account: Account;
  draft: ComposerDraft;
  onClose: () => void;
  onSent: () => void;
  onSendActivity: (activity: SendActivity) => void;
  /** Unique among open composers: several can be written in parallel. */
  windowId: string;
  /**
   * How many steps this window is offset from the bottom-right corner until
   * it is dragged, so a new window never hides the previous one exactly.
   */
  cascade: number;
}

/** Title of the window, also the label of its taskbar button. */
export function composerTitle(draft: ComposerDraft): string {
  return draft.kind === 'reply' ? 'Réponse' : draft.kind === 'forward' ? 'Transfert' : 'Nouveau message';
}

export default function Composer({
  account,
  draft,
  onClose,
  onSent,
  onSendActivity,
  windowId,
  cascade,
}: Props) {
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [subject, setSubject] = useState(draft.subject);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [linkRequest, setLinkRequest] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState((draft.files?.length ?? 0) > 0);
  // Keys of the progress shown in the send button (lib/progress.ts).
  const [importOp] = useState(newOpId);
  const [sendOp, setSendOp] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Changes made by the user since the window opened. The seeded text (a
  // quote, a signature) and forwarded attachments do not count: a reply
  // opened and closed untouched closes without a question.
  const [bodyEdited, setBodyEdited] = useState(false);
  const [filesEdited, setFilesEdited] = useState(false);
  const edited =
    bodyEdited || filesEdited || to !== draft.to || cc !== draft.cc || subject !== draft.subject;
  const closing = useRef(false);
  // On the taskbar, a message is known by its subject once it has one.
  const { minimized, layer, activate, minimize } = useManagedWindow(windowId, {
    label: subject.trim() || composerTitle(draft),
    icon: PenSquare,
  });
  const { panelRef, position, size, moving, resizing, handleProps, onResizePointerDown, onResizeKeyDown } =
    useWindowDrag<HTMLDivElement>({ minWidth: MIN_WINDOW_WIDTH, minHeight: MIN_WINDOW_HEIGHT });
  const fileInput = useRef<HTMLInputElement>(null);
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<PendingFile[]>([]);
  filesRef.current = files;
  // ProseMirror keeps the props it was created with: handlers reach the current render through this.
  const actionsRef = useRef({ insertInlineImages, addFiles });
  actionsRef.current = { insertInlineImages, addFiles };

  const editor = useEditor({
    extensions: composeExtensions(EDITOR_PLACEHOLDER),
    content: textToDoc(draft.body),
    editorProps: {
      attributes: {
        class: 'mf-editor-surface',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': "Votre message. Collez une capture d'écran avec Ctrl+V.",
        spellcheck: 'true',
      },
      handlePaste(view, event) {
        const { images, others } = filesFromClipboard(event.clipboardData);
        if (images.length || others.length) {
          if (images.length) actionsRef.current.insertInlineImages(images);
          if (others.length) actionsRef.current.addFiles(others);
          return true;
        }
        insertPlainText(view, event.clipboardData?.getData('text/plain') ?? '');
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        const data = event.dataTransfer;
        if (!data) return false;
        if ([...data.types].includes('Files')) {
          // The panel's drop handler files them; the caret marks where images go.
          placeCaretAt(view, event.clientX, event.clientY);
          return true;
        }
        if (moved) return false;
        const text = data.getData('text/plain');
        if (!text) return false;
        placeCaretAt(view, event.clientX, event.clientY);
        insertPlainText(view, text);
        return true;
      },
      handleKeyDown(_view, event) {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          setLinkRequest((count) => count + 1);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      setBodyEdited(true);
      syncInlineImages(inlineImageIds(current.state.doc));
    },
  });

  useEffect(() => {
    return () => {
      for (const item of filesRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  const seedKey = (draft.files ?? []).map((file) => file.url).join('\n');

  useEffect(() => {
    const seeds = draft.files ?? [];
    if (!seeds.length) return;
    const controller = new AbortController();
    let cancelled = false;
    setImporting(true);
    void (async () => {
      const loaded: File[] = [];
      const failed: string[] = [];
      try {
        for (const [done, seed] of seeds.entries()) {
          reportProgress(importOp, done / seeds.length, (done + 1) / seeds.length);
          try {
            const response = await fetch(seed.url, { signal: controller.signal });
            if (!response.ok) throw new Error(String(response.status));
            const blob = await response.blob();
            const type = seed.contentType || blob.type || 'application/octet-stream';
            loaded.push(new File([blob], seed.filename || 'piece-jointe', { type }));
          } catch {
            if (controller.signal.aborted) break;
            failed.push(seed.filename || 'piece-jointe');
          }
        }
        if (cancelled) return;
        const rejected = loaded.length ? addFiles(loaded) : null;
        const missing =
          failed.length === 0
            ? null
            : failed.length === 1
              ? `Pièce jointe introuvable : ${failed[0]}`
              : `${failed.length} pièces jointes introuvables.`;
        const combined = [rejected, missing].filter(Boolean).join(' ');
        if (combined) setNotice(combined);
      } finally {
        if (!cancelled) setImporting(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Les fichiers d'origine ne changent pas tant que le panneau n'est pas rouvert.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const sendersQuery = useQuery({
    queryKey: ['senders', account.id],
    queryFn: () => api.senders(account.id),
    staleTime: 60_000,
  });
  const senders = sendersQuery.data ?? [];

  const send = useMutation({
    mutationFn: async () => {
      const op = newOpId();
      setSendOp(op);
      const current = filesRef.current;
      const known = new Set(current.filter((item) => item.inline).map((item) => item.id));
      const serialized = serializeDoc(editor.getJSON(), known);
      const used = new Set(serialized.imageIds);
      const outgoing = current.filter((item) => !item.inline || used.has(item.id));
      // Reading the files is the first tenth of a send; the server reports the rest.
      let read = 0;
      if (outgoing.length) reportProgress(op, 0, 0.1 / outgoing.length);
      const attachments = await Promise.all(
        outgoing.map(async (item) => {
          const content = await readFileAsBase64(item.file);
          read += 1;
          reportProgress(op, (0.1 * read) / outgoing.length, (0.1 * (read + 1)) / outgoing.length);
          return {
            filename: item.file.name,
            contentType: item.file.type || 'application/octet-stream',
            content,
            ...(item.inline && used.has(item.id) ? { cid: item.id } : {}),
          };
        }),
      );
      const mail = {
        to,
        cc,
        subject,
        text: serialized.text,
        html: serialized.rich ? serialized.html : undefined,
        inReplyTo: draft.inReplyTo,
        references: draft.references,
        attachments: attachments.length ? attachments : undefined,
      };
      return api.send(account.id, mail, op);
    },
  });

  function submit() {
    if (send.isPending || importing || !to.trim()) return;
    const recipients = summarizeAddresses(to, cc);
    const currentSubject = subject;
    onSendActivity({ phase: 'sending', recipients, subject: currentSubject });
    // La promesse survit à la fermeture du panneau : le toast doit quand même
    // afficher la confirmation ou l'erreur.
    void send
      .mutateAsync()
      .then((result) => {
        const accepted = result.accepted ?? [];
        const rejected = result.rejected ?? [];
        if (accepted.length === 0 && rejected.length > 0) {
          onSendActivity({
            phase: 'error',
            message: `Refusé par le serveur : ${rejected.join(', ')}`,
          });
          return;
        }
        onSendActivity({
          phase: 'sent',
          recipients,
          subject: currentSubject,
          accepted,
          rejected,
          copiedTo: result.copiedTo ?? null,
          copiedBy: result.copiedBy ?? null,
          copyError: result.copyError ?? null,
        });
        onSent();
      })
      .catch((error: unknown) => {
        onSendActivity({ phase: 'error', message: sendErrorMessage(error) });
      });
  }

  function rejectFile(file: File, next: PendingFile[]): string | null {
    if (next.length >= MAX_ATTACHMENTS) return `Maximum ${MAX_ATTACHMENTS} pièces jointes.`;
    if (file.size > MAX_ATTACHMENT_BYTES) return `« ${file.name} » dépasse 10 Mo.`;
    const total = next.reduce((sum, item) => sum + item.file.size, 0) + file.size;
    if (total > MAX_ATTACHMENTS_BYTES) return 'Les pièces jointes dépassent 20 Mo au total.';
    return null;
  }

  function commitFiles(next: PendingFile[]) {
    filesRef.current = next;
    setFiles(next);
  }

  function addFiles(list: FileList | readonly File[] | null): string | null {
    if (list && list.length > 0) setFilesEdited(true);
    if (!list?.length) return null;
    send.reset();
    const next = [...filesRef.current];
    let message: string | null = null;
    for (const file of list) {
      const reason = rejectFile(file, next);
      if (reason) {
        message = reason;
        if (next.length >= MAX_ATTACHMENTS) break;
        continue;
      }
      const previewUrl = isInlineImageType(file.type) ? URL.createObjectURL(file) : undefined;
      next.push({ id: crypto.randomUUID(), file, inline: false, previewUrl });
    }
    commitFiles(next);
    setNotice(message);
    if (fileInput.current) fileInput.current.value = '';
    return message;
  }

  /** Deleting a screenshot in the text also drops it from the attachment list. */
  function syncInlineImages(ids: ReadonlySet<string>) {
    setFiles((current) => {
      const removed = current.filter((item) => item.inline && !ids.has(item.id));
      if (!removed.length) return current;
      for (const item of removed) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      const next = current.filter((item) => !item.inline || ids.has(item.id));
      filesRef.current = next;
      return next;
    });
  }

  function insertInlineImages(incoming: File[]) {
    if (!incoming.length) return;
    send.reset();
    const next = [...filesRef.current];
    const taken = new Set(next.map((item) => item.file.name));
    let message: string | null = null;
    const created: PendingFile[] = [];

    for (const raw of incoming) {
      const file = fileForClipboardImage(raw, taken);
      const reason = rejectFile(file, next);
      if (reason) {
        message = reason;
        if (next.length >= MAX_ATTACHMENTS) break;
        continue;
      }
      const item: PendingFile = {
        id: crypto.randomUUID(),
        file,
        inline: true,
        previewUrl: URL.createObjectURL(file),
      };
      next.push(item);
      taken.add(file.name);
      created.push(item);
    }

    setNotice(message);
    if (!created.length) return;
    commitFiles(next);
    editor
      .chain()
      .focus()
      .insertContent(
        created.flatMap((item) => [
          { type: 'inlineImage', attrs: { id: item.id, src: item.previewUrl, alt: item.file.name } },
          { type: 'hardBreak' },
        ]),
      )
      .run();
  }

  /**
   * Close button. A message the user wrote in is not thrown away on one
   * click: they confirm first, and a refusal brings the window back to the
   * front. One question at a time, however often the button is pressed.
   */
  async function requestClose() {
    if (!edited) {
      onClose();
      return;
    }
    if (closing.current) return;
    closing.current = true;
    const name = subject.trim();
    const confirmed = await confirmDialog({
      title: 'Fermer ce message ?',
      message: name
        ? `Le message « ${name} » n'a pas été envoyé. Si vous le fermez, ce que vous y avez écrit sera perdu.`
        : "Ce message n'a pas été envoyé. Si vous le fermez, ce que vous y avez écrit sera perdu.",
      confirmLabel: 'Fermer sans envoyer',
      cancelLabel: 'Continuer la rédaction',
      danger: true,
    });
    closing.current = false;
    if (confirmed) {
      onClose();
      return;
    }
    restoreWindow(windowId);
  }

  function removeFile(id: string) {
    setFilesEdited(true);
    editor.commands.command(({ tr }) => {
      const ranges: [number, number][] = [];
      tr.doc.descendants((node, pos) => {
        if (node.type.name === 'inlineImage' && node.attrs.id === id) ranges.push([pos, pos + node.nodeSize]);
      });
      for (const [from, to] of ranges.reverse()) tr.delete(from, to);
      return ranges.length > 0;
    });
    setFiles((current) => {
      for (const item of current) {
        if (item.id === id && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      const next = current.filter((item) => item.id !== id);
      filesRef.current = next;
      return next;
    });
  }

  /** Paste outside the text (address or subject field). Inside it, `handlePaste` decides. */
  function onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    if (editorBoxRef.current?.contains(event.target as Node)) return;
    const { images, others } = filesFromClipboard(event.clipboardData);
    if (images.length) {
      event.preventDefault();
      insertInlineImages(images);
      if (others.length) addFiles(others);
      return;
    }
    if (others.length) {
      event.preventDefault();
      addFiles(others);
    }
  }

  return (
    <div
      ref={panelRef}
      id={`mf-window-${windowId}`}
      tabIndex={-1}
      role="dialog"
      aria-label={composerTitle(draft)}
      style={{
        zIndex: layer,
        ...(size
          ? { width: size.width, height: size.height, maxWidth: 'none', maxHeight: 'none' }
          : {}),
        ...(position
          ? { left: position.x, top: position.y }
          : {
              // Above the taskbar when it shows: App sets --mf-taskbar-h.
              right: `${1.5 + 2 * cascade}rem`,
              bottom: `calc(${1.5 + 2 * cascade}rem + var(--mf-taskbar-h, 0px))`,
            }),
      }}
      data-dragging={dragging || undefined}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      className={cn(
        'mf-window mf-window-composer pointer-events-auto fixed flex h-[36rem] max-h-[calc(100dvh-3rem-var(--mf-taskbar-h,0px))] w-[min(42rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-lg border bg-surface shadow-2xl outline-none',
        dragging ? 'border-accent' : 'border-line',
        (moving || resizing) && 'select-none',
        minimized && 'hidden',
      )}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setDragging(false);
        const dropped = [...event.dataTransfer.files];
        if (!editorBoxRef.current?.contains(event.target as Node)) {
          addFiles(dropped);
          return;
        }
        const images = dropped.filter((file) => isInlineImageType(file.type));
        const rest = dropped.filter((file) => !isInlineImageType(file.type));
        if (images.length) insertInlineImages(images);
        if (rest.length) addFiles(rest);
      }}
      onPaste={onPaste}
    >
      <div
        title="Glisser pour déplacer"
        {...handleProps}
        className="mf-window-title flex cursor-grab touch-none items-center gap-1 border-b border-line px-4 py-3 select-none active:cursor-grabbing"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          <GripHorizontal className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <span className="truncate">
            {composerTitle(draft)} — {account.email}
          </span>
        </span>
        <WindowControls onMinimize={minimize} onClose={requestClose} />
      </div>

      {/* Tout sauf la barre de titre : un thème peut l'encadrer comme la zone
          cliente d'une fenêtre. */}
      <div className="mf-window-body flex min-h-0 flex-1 flex-col">
        <AddressField
          label="À"
          value={to}
          onChange={setTo}
          placeholder="destinataire@exemple.fr"
          senders={senders}
          excludeValues={[to, cc]}
        />
        <AddressField
          label="Cc"
          value={cc}
          onChange={setCc}
          placeholder="facultatif"
          senders={senders}
          excludeValues={[to, cc]}
        />
        <Field label="Objet" value={subject} onChange={setSubject} placeholder="" />

        <ComposerToolbar editor={editor} linkRequest={linkRequest} />

        <div
          ref={editorBoxRef}
          onMouseDown={(event) => {
            // A click on the blank paper below the last line still puts the caret in the text.
            if (event.target === event.currentTarget) {
              event.preventDefault();
              editor.commands.focus('end');
            }
          }}
          className="mf-editor min-h-0 flex-1 cursor-text overflow-y-auto px-4 py-3"
        >
          <EditorContent editor={editor} />
        </div>

        {files.length > 0 && (
          <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto border-t border-line px-4 py-3">
            {files.map((item) => (
              <span
                key={item.id}
                className="flex max-w-full items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-1 text-xs"
              >
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="" className="size-8 rounded-sm object-cover" />
                ) : (
                  <Paperclip className="size-3.5 shrink-0 text-ink-muted" />
                )}
                <span className="max-w-56 truncate">{item.file.name}</span>
                {item.inline && <span className="text-ink-muted">dans le message</span>}
                <span className="text-ink-muted">{formatSize(item.file.size)}</span>
                <button
                  type="button"
                  title={
                    item.inline
                      ? `Retirer ${item.file.name} du message`
                      : `Retirer ${item.file.name}`
                  }
                  onClick={() => removeFile(item.id)}
                  className="mf-icon-btn rounded-sm p-0.5 text-ink-muted hover:bg-surface-hover hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mf-window-foot flex items-center gap-3 border-t border-line px-4 py-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => addFiles(event.target.files)}
          />
          <button
            type="button"
            title="Joindre un fichier"
            onClick={() => fileInput.current?.click()}
            className="mf-icon-btn rounded-md p-2 text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <Paperclip className="size-4" />
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={send.isPending || importing || !to.trim()}
            aria-busy={send.isPending || importing}
            className={cn(
              'mf-btn-primary relative isolate flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90',
              // Busy, not unavailable: a filling button keeps its full color.
              !(send.isPending || importing) && 'disabled:opacity-40',
            )}
          >
            <ProgressFill
              op={importing ? importOp : sendOp}
              running={send.isPending || importing}
              kind={importing ? 'import' : 'send'}
            />
            {importing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {importing ? 'Pièces jointes…' : send.isPending ? 'Envoi…' : 'Envoyer'}
          </button>

          {notice && (
            <span className="min-w-0 truncate text-sm text-warn">{notice}</span>
          )}
        </div>
      </div>
      <WindowResize onPointerDown={onResizePointerDown} onKeyDown={onResizeKeyDown} />
    </div>
  );
}

function summarizeAddresses(to: string, cc: string): string {
  const list = [to, cc]
    .flatMap((value) => value.split(/[,;]/))
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length <= 2) return list.join(', ');
  return `${list[0]}, ${list[1]} +${list.length - 2}`;
}

function sendErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || error.message.trim() === '') return 'Envoi impossible.';
  if (
    error.message === 'Failed to fetch' ||
    error.message === 'NetworkError when attempting to fetch resource.'
  ) {
    return 'Le serveur ne répond pas.';
  }
  return error.message;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`Lecture de « ${file.name} » impossible`));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Lecture de « ${file.name} » impossible`));
    reader.readAsDataURL(file);
  });
}

const SUGGESTION_LIMIT = 8;

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function activeToken(value: string): { prefix: string; token: string } {
  const lastSep = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
  if (lastSep === -1) return { prefix: '', token: value };
  return { prefix: value.slice(0, lastSep + 1), token: value.slice(lastSep + 1) };
}

function chosenAddresses(values: string[], active: string): Set<string> {
  const current = active.trim().toLowerCase();
  const chosen = new Set<string>();
  for (const value of values) {
    for (const part of value.split(/[,;]/)) {
      const email = part.trim().toLowerCase();
      if (email && email !== current) chosen.add(email);
    }
  }
  return chosen;
}

function rankSenders(senders: Sender[], token: string, exclude: Set<string>): Sender[] {
  const needle = fold(token.trim());
  if (!needle) return [];
  const exact = token.trim().toLowerCase();
  const ranked: { sender: Sender; rank: number }[] = [];
  for (const sender of senders) {
    if (exclude.has(sender.email) || sender.email === exact) continue;
    const email = fold(sender.email);
    const name = fold(sender.name ?? '');
    const rank = email.startsWith(needle) || name.startsWith(needle) ? 0 : 1;
    if (rank === 1 && !email.includes(needle) && !name.includes(needle)) continue;
    ranked.push({ sender, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.sender.lastSeen - a.sender.lastSeen);
  return ranked.slice(0, SUGGESTION_LIMIT).map((item) => item.sender);
}

function applyAddress(value: string, email: string): string {
  const { prefix } = activeToken(value);
  const glue = prefix === '' || prefix.endsWith(' ') ? '' : ' ';
  return `${prefix}${glue}${email}, `;
}

function AddressField({
  label,
  value,
  onChange,
  placeholder,
  senders,
  excludeValues,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  senders: Sender[];
  excludeValues: string[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number; bottom: number } | null>(
    null,
  );

  const { token } = activeToken(value);
  const matches = rankSenders(senders, token, chosenAddresses(excludeValues, token));
  const open = focused && matches.length > 0 && dismissed !== token;
  const activeIndex = Math.min(highlight, Math.max(matches.length - 1, 0));

  useEffect(() => {
    setHighlight(0);
  }, [token]);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const tick = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (rect) {
        const next = {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          bottom: Math.round(rect.bottom),
        };
        setBox((current) =>
          current &&
          current.top === next.top &&
          current.left === next.left &&
          current.width === next.width &&
          current.bottom === next.bottom
            ? current
            : next,
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function choose(sender: Sender) {
    onChange(applyAddress(value, sender.email));
    setDismissed(null);
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((index) => (index + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      const sender = matches[activeIndex];
      if (!sender) return;
      event.preventDefault();
      choose(sender);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(token);
    }
  }

  const listHeight = matches.length * 44 + 8;
  const placeAbove = box != null && window.innerHeight - box.bottom < listHeight && box.top > listHeight;

  const list =
    open && box
      ? createPortal(
          <ul
            id={listId}
            role="listbox"
            style={{
              position: 'fixed',
              left: box.left,
              width: Math.max(box.width, 280),
              top: placeAbove ? box.top - listHeight - 4 : box.bottom + 4,
              zIndex: 60,
            }}
            className="mf-popover overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-2xl"
          >
            {matches.map((sender, index) => (
              <li key={sender.email} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(sender)}
                  className={cn(
                    'mf-option flex w-full min-w-0 flex-col px-3 py-1.5 text-left',
                    index === activeIndex && 'bg-surface-hover',
                  )}
                >
                  <span className="truncate text-sm">{sender.name || sender.email}</span>
                  {sender.name && (
                    <span className="truncate text-xs text-ink-muted">{sender.email}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )
      : null;

  return (
    <label className="mf-field-row flex items-center gap-3 border-b border-line px-4">
      <span className="w-12 shrink-0 text-xs text-ink-muted">{label}</span>
      <input
        ref={inputRef}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setDismissed(null);
          setFocused(true);
          onChange(event.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="mf-field flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-ink-muted"
      />
      {list}
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="mf-field-row flex items-center gap-3 border-b border-line px-4">
      <span className="w-12 shrink-0 text-xs text-ink-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mf-field flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-ink-muted"
      />
    </label>
  );
}
