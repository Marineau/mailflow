import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GripHorizontal, Trash2, UserPlus, Users } from './icons';
import WindowControls from './WindowControls';
import AccountSetup from './AccountSetup';
import { api, type Account } from '../lib/api';
import { alertDialog, confirmDialog } from '../lib/dialog';
import { useWindowDrag } from '../lib/useWindowDrag';
import { useManagedWindow } from '../lib/windows';
import { cn } from '../lib/utils';

interface Props {
  onClose: () => void;
  /** An account was just added and is ready: the app may switch to it. */
  onAdded: (account: Account) => void;
  /** Opens straight on the « add an account » form. */
  startAdding?: boolean;
}

/**
 * The accounts window: the list of mailboxes, with the way to add one and to
 * remove one added here. Accounts declared in `.env` are listed but stay
 * read-only: the file is their source.
 *
 * A floating window like the theme picker (useManagedWindow, useWindowDrag):
 * not modal, minimizable, Escape closes it while the focus is inside.
 */
export default function AccountsWindow({ onClose, onAdded, startAdding = false }: Props) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [adding, setAdding] = useState(startAdding);
  const [removing, setRemoving] = useState<string | null>(null);
  const { minimized, layer, activate, minimize } = useManagedWindow('accounts', {
    label: 'Comptes',
    icon: Users,
  });
  const { panelRef, position, moving, handleProps } = useWindowDrag<HTMLDivElement>();
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(account: Account) {
    const confirmed = await confirmDialog({
      title: 'Retirer le compte',
      message: `Retirer ${account.email} de Pli ?\n\nLes mails restent sur le serveur de votre fournisseur. Pli oublie le mot de passe ou l’autorisation, ainsi que sa copie locale des en-têtes et des mails ouverts.`,
      confirmLabel: 'Retirer',
      danger: true,
    });
    if (!confirmed) return;
    setRemoving(account.id);
    try {
      await api.removeAccount(account.id);
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (err) {
      await alertDialog({ title: 'Retrait impossible', message: (err as Error).message });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div
      ref={panelRef}
      id="mf-window-accounts"
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
      className={cn(
        'mf-window pointer-events-auto fixed flex max-h-[calc(100dvh-2rem-var(--mf-taskbar-h,0px))] w-[min(36rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl outline-none',
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
          <Users className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          {adding ? 'Ajouter un compte' : 'Comptes'}
        </h2>
        <WindowControls onMinimize={minimize} onClose={onClose} />
      </div>

      <div className="mf-window-body flex min-h-0 flex-col">
        <div className="min-h-0 overflow-y-auto p-4">
          {adding ? (
            <AccountSetup
              onCancel={() => setAdding(false)}
              onDone={(account) => {
                setAdding(false);
                onAdded(account);
              }}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {accounts.data?.map((account) => (
                <li
                  key={account.id}
                  className="mf-theme-card mf-choice flex items-center gap-3 rounded-lg border border-line p-3"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{account.label}</span>
                    <span className="truncate text-xs text-ink-muted">{account.email}</span>
                    <span className="text-xs text-ink-muted">
                      {describe(account)}
                      {!account.authorized && (
                        <span className="text-warn"> · autorisation en attente</span>
                      )}
                    </span>
                  </span>
                  {!account.authorized && (
                    <a
                      href={`/api/accounts/${encodeURIComponent(account.id)}/oauth`}
                      target="mf-oauth"
                      className="mf-btn flex shrink-0 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs hover:bg-surface-hover"
                    >
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      Autoriser
                    </a>
                  )}
                  {account.source === 'app' ? (
                    <button
                      type="button"
                      onClick={() => void remove(account)}
                      disabled={removing === account.id}
                      title={`Retirer ${account.email}`}
                      aria-label={`Retirer ${account.email}`}
                      className="mf-icon-btn flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  ) : (
                    <span
                      className="shrink-0 text-xs text-ink-muted"
                      title="Déclaré dans le fichier .env du serveur : c’est là qu’il se modifie."
                    >
                      Fichier .env
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!adding && (
          <div className="mf-window-foot flex shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-3">
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="mf-btn-primary flex cursor-pointer items-center gap-2 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:opacity-90"
            >
              <UserPlus className="size-4" aria-hidden="true" />
              Ajouter un compte
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mf-btn cursor-pointer rounded-md border border-line px-4 py-1.5 text-sm hover:bg-surface-hover"
            >
              Fermer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function describe(account: Account): string {
  if (account.authMode === 'password') return 'Connexion par mot de passe';
  return account.provider === 'google' ? 'Connexion Google' : 'Connexion Microsoft';
}
