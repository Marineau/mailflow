import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, ChevronRight, ExternalLink, Loader2 } from './icons';
import { api, type Account, type AccountInput, type ServerSettings } from '../lib/api';
import { IN_DESKTOP_APP } from '../lib/desktopApp';
import { PROVIDERS, withDomain, type ProviderPreset } from '../lib/providers';
import { cn } from '../lib/utils';
import { newOpId } from '../lib/progress';
import ProgressFill from './ProgressFill';

interface Props {
  /** Called once the account is added and, for OAuth, authorized. */
  onDone: (account: Account) => void;
  /** Shown as « Annuler » on the first step when given. */
  onCancel?: () => void;
}

type Step =
  | { kind: 'choose' }
  | { kind: 'form'; provider: ProviderPreset }
  | { kind: 'consent'; provider: ProviderPreset; account: Account; popupBlocked: boolean };

/**
 * Adding a mail account, in three steps: pick the provider, fill the form,
 * and for Microsoft or Google wait for the consent opened in a popup.
 *
 * Used twice: inline on the welcome screen when no account exists yet, and
 * inside the accounts window. Drawn only with tokens and `mf-*` hooks, so it
 * follows the theme of whatever hosts it.
 */
export default function AccountSetup({ onDone, onCancel }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'choose' });

  if (step.kind === 'choose') {
    return (
      <ProviderChoice
        onPick={(provider) => setStep({ kind: 'form', provider })}
        onCancel={onCancel}
      />
    );
  }

  if (step.kind === 'form') {
    return (
      <AccountForm
        key={step.provider.id}
        provider={step.provider}
        onBack={() => setStep({ kind: 'choose' })}
        onAdded={(account, popupBlocked) => {
          if (account.authorized) onDone(account);
          else setStep({ kind: 'consent', provider: step.provider, account, popupBlocked });
        }}
      />
    );
  }

  return <ConsentWait account={step.account} popupBlocked={step.popupBlocked} onDone={onDone} />;
}

function ProviderChoice({
  onPick,
  onCancel,
}: {
  onPick: (provider: ProviderPreset) => void;
  onCancel?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-ink-muted">
        Chez quel fournisseur se trouve votre boîte ? Les réglages des serveurs sont préremplis, et
        restent modifiables.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => onPick(provider)}
            className="mf-theme-card mf-choice group flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium">{provider.name}</span>
              <span className="text-xs leading-relaxed text-ink-muted">{provider.blurb}</span>
            </span>
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          </button>
        ))}
      </div>
      {onCancel && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="mf-btn cursor-pointer rounded-md border border-line px-4 py-1.5 text-sm hover:bg-surface-hover"
          >
            Annuler
          </button>
        </div>
      )}
    </div>
  );
}

function AccountForm({
  provider,
  onBack,
  onAdded,
}: {
  provider: ProviderPreset;
  onBack: () => void;
  onAdded: (account: Account, popupBlocked: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ['account-setup'], queryFn: api.accountSetup });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [fromName, setFromName] = useState('');
  // Gmail offers both ways in; the others have only the one of their preset.
  // `null` until chosen. Signing in with Google takes a Google application:
  // where Pli knows none, the app password is the way that needs nothing
  // but a Google account, so it is the one offered first.
  const [passwordChoice, setUsePassword] = useState<boolean | null>(null);
  const googleAppKnown = Boolean(setup.data?.googleClientId && setup.data.googleSecretConfigured);
  const usePassword =
    passwordChoice ??
    (provider.auth === 'password' || (provider.auth === 'google' && setup.isSuccess && !googleAppKnown));
  const auth = usePassword ? 'password' : provider.auth;

  const [showServers, setShowServers] = useState(provider.id === 'other');
  // `null` until edited: the preset follows the address typed until then.
  const [imapEdit, setImapEdit] = useState<ServerSettings | null>(null);
  const [smtpEdit, setSmtpEdit] = useState<ServerSettings | null>(null);
  const [userName, setUserName] = useState('');
  const imap = imapEdit ?? withDomain(provider.imap, email);
  const smtp = smtpEdit ?? withDomain(provider.smtp, email);

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tenant, setTenant] = useState('consumers');

  const [busy, setBusy] = useState<null | 'test' | 'add'>(null);
  // Key of the progress shown in the busy button (lib/progress.ts).
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ imap: string | null; smtp: string | null } | null>(null);

  const googleNeedsApp = auth === 'google' && !googleAppKnown;
  const microsoftNeedsApp = auth === 'microsoft' && setup.isSuccess && !setup.data.microsoftClientId;

  const input = useMemo<AccountInput>(
    () => ({
      email: email.trim(),
      label: label.trim() || undefined,
      fromName: fromName.trim() || undefined,
      authMode: auth === 'password' ? 'password' : 'oauth2',
      password: auth === 'password' ? password : undefined,
      provider: auth === 'password' ? undefined : auth,
      clientId: clientId.trim() || undefined,
      clientSecret: auth === 'google' ? clientSecret.trim() || undefined : undefined,
      tenant: auth === 'microsoft' ? tenant : undefined,
      imap: { ...imap, user: userName.trim() || undefined },
      smtp: { ...smtp, user: userName.trim() || undefined },
    }),
    [email, label, fromName, auth, password, clientId, clientSecret, tenant, imap, smtp, userName],
  );

  const ready =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    (auth !== 'password' || password.length > 0) &&
    (!googleNeedsApp || (clientId.trim() && clientSecret.trim())) &&
    (!microsoftNeedsApp || clientId.trim());

  async function runTest() {
    const op = newOpId();
    setBusyOp(op);
    setBusy('test');
    setError(null);
    setTest(null);
    try {
      setTest(await api.testAccount(input, op));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    const op = newOpId();
    setBusyOp(op);
    setBusy('add');
    setError(null);
    setTest(null);
    // Opened before the request, still inside the click: a popup opened after
    // an `await` is blocked by the browser.
    const popup = auth === 'password' ? null : window.open('', 'mf-oauth', 'popup,width=520,height=700');
    try {
      const account = await api.addAccount(input, op);
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      if (!account.authorized) {
        const url = `/api/accounts/${encodeURIComponent(account.id)}/oauth`;
        if (popup) popup.location.href = url;
        // The desktop app refused the empty window above, and hands this
        // address to the system browser, click or not.
        else if (IN_DESKTOP_APP) window.open(url, 'mf-oauth');
        onAdded(account, !popup);
      } else {
        onAdded(account, false);
      }
    } catch (err) {
      popup?.close();
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const providerName = auth === 'google' ? 'Google' : 'Microsoft';

  return (
    <form onSubmit={add} className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={onBack}
          className="mf-link cursor-pointer text-accent hover:underline"
        >
          Fournisseurs
        </button>
        <ChevronRight className="size-3.5 text-ink-muted" aria-hidden="true" />
        <span className="font-medium">{provider.name}</span>
      </div>

      {provider.id === 'gmail' && (
        <div role="radiogroup" aria-label="Mode de connexion" className="flex flex-col gap-1.5">
          <Radio
            checked={!usePassword}
            onChange={() => setUsePassword(false)}
            label="Connexion avec le compte Google"
            hint={
              googleAppKnown
                ? 'Le mot de passe reste chez Google.'
                : 'Pour qui a déclaré sa propre application dans Google Cloud. Sinon, prenez le mot de passe d’application.'
            }
          />
          <Radio
            checked={usePassword}
            onChange={() => setUsePassword(true)}
            label="Mot de passe d’application"
            hint="Plus rapide à mettre en place ; suppose la validation en deux étapes activée."
          />
        </div>
      )}

      <Field label="Adresse e-mail">
        <input
          type="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="prenom@exemple.fr"
          className={INPUT}
        />
      </Field>

      {auth === 'password' && (
        <Field label="Mot de passe" hint={provider.passwordHint}>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT}
          />
        </Field>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Nom dans la barre latérale" hint="Facultatif, par exemple « Pro ».">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            className={INPUT}
          />
        </Field>
        <Field label="Nom vu par vos destinataires" hint="Facultatif.">
          <input
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            maxLength={80}
            autoComplete="name"
            className={INPUT}
          />
        </Field>
      </div>

      {googleNeedsApp && (
        <GoogleAppHelp
          redirectUri={setup.data?.redirectUri ?? 'http://localhost:4100/api/oauth/callback'}
          clientId={clientId}
          clientSecret={clientSecret}
          onClientId={setClientId}
          onClientSecret={setClientSecret}
        />
      )}

      {microsoftNeedsApp && (
        <Field
          label="Identifiant de l’application Microsoft"
          hint="Aucune application Microsoft n’est encore déclarée sur ce poste. Inscrivez-en une dans Microsoft Entra (client public, adresse de retour indiquée dans docs/accounts.md), puis collez ici son identifiant."
        >
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={INPUT} />
        </Field>
      )}

      <details
        open={showServers}
        onToggle={(e) => setShowServers((e.target as HTMLDetailsElement).open)}
        className="rounded-md border border-line"
      >
        <summary className="cursor-pointer px-3 py-2 text-sm select-none">
          Réglages avancés
        </summary>
        <div className="flex flex-col gap-4 border-t border-line p-3">
          <ServerFields
            title="Réception (IMAP)"
            value={imap}
            onChange={setImapEdit}
          />
          <ServerFields
            title="Envoi (SMTP)"
            value={smtp}
            onChange={setSmtpEdit}
          />
          {auth === 'password' && (
            <Field label="Identifiant de connexion" hint="Laissez vide pour utiliser l’adresse e-mail.">
              <input
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                autoComplete="username"
                className={INPUT}
              />
            </Field>
          )}
          {auth === 'microsoft' && (
            <>
              <Field label="Type de compte">
                <select
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  className={INPUT}
                >
                  <option value="consumers">Compte personnel (Outlook.com, Hotmail)</option>
                  <option value="common">Compte professionnel ou scolaire</option>
                </select>
              </Field>
              {!microsoftNeedsApp && (
                <Field
                  label="Identifiant de l’application Microsoft"
                  hint="Laissez vide pour utiliser l’application déjà déclarée sur ce poste."
                >
                  <input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className={INPUT}
                  />
                </Field>
              )}
            </>
          )}
        </div>
      </details>

      {test && <TestResult result={test} />}
      {error && (
        <p role="alert" className="flex gap-2 text-sm leading-relaxed text-warn">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="mf-window-foot -mx-4 -mb-4 flex items-center justify-end gap-2 border-t border-line px-4 py-3">
        {auth === 'password' && (
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={!ready || busy !== null}
            aria-busy={busy === 'test'}
            className={cn(
              'mf-btn relative isolate mr-auto flex cursor-pointer items-center gap-2 rounded-md border border-line px-4 py-1.5 text-sm hover:bg-surface-hover disabled:cursor-default',
              busy !== 'test' && 'disabled:opacity-50',
            )}
          >
            <ProgressFill op={busyOp} running={busy === 'test'} kind="account" />
            {busy === 'test' && <Loader2 className="size-4 animate-spin" />}
            Tester la connexion
          </button>
        )}
        <button
          type="submit"
          disabled={!ready || busy !== null}
          aria-busy={busy === 'add'}
          className={cn(
            'mf-btn-primary relative isolate flex cursor-pointer items-center gap-2 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-default',
            busy !== 'add' && 'disabled:opacity-50',
          )}
        >
          {auth === 'password' && (
            <ProgressFill op={busyOp} running={busy === 'add'} kind="account" />
          )}
          {busy === 'add' && <Loader2 className="size-4 animate-spin" />}
          {auth === 'password'
            ? busy === 'add'
              ? 'Vérification…'
              : 'Ajouter le compte'
            : `Continuer avec ${providerName}`}
        </button>
      </div>
    </form>
  );
}

/**
 * The consent runs in a popup on the server's origin. Its callback page
 * closes itself; this side only watches `/api/accounts` until the account
 * reports itself authorized.
 */
function ConsentWait({
  account,
  popupBlocked,
  onDone,
}: {
  account: Account;
  popupBlocked: boolean;
  onDone: (account: Account) => void;
}) {
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: api.accounts,
    refetchInterval: 2000,
  });
  const current = accounts.data?.find((item) => item.id === account.id);
  const done = useRef(false);

  useEffect(() => {
    if (current?.authorized && !done.current) {
      done.current = true;
      onDone(current);
    }
  }, [current, onDone]);

  const providerName = account.provider === 'google' ? 'Google' : 'Microsoft';
  const url = `/api/accounts/${encodeURIComponent(account.id)}/oauth`;
  // In the desktop app no popup is not a blocked popup: the consent has been
  // sent to the system browser, which is where it is meant to run.
  const blocked = popupBlocked && !IN_DESKTOP_APP;

  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      {current?.authorized ? (
        <Check className="size-6 text-accent" aria-hidden="true" />
      ) : (
        <Loader2 className="size-6 animate-spin text-ink-muted" aria-hidden="true" />
      )}
      <p className="text-sm font-medium">
        {blocked
          ? `Autorisez Pli chez ${providerName}`
          : `En attente de votre autorisation chez ${providerName}…`}
      </p>
      <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
        {blocked
          ? 'Le navigateur a bloqué la fenêtre de connexion. Ouvrez-la avec le bouton ci-dessous ; cette page se mettra à jour dès que l’accès sera accordé.'
          : IN_DESKTOP_APP
            ? `La connexion à ${account.email} s’est ouverte dans votre navigateur. Acceptez-y l’accès demandé, puis revenez ici : cette page se mettra à jour d’elle-même.`
            : `Connectez-vous à ${account.email} dans la fenêtre qui vient de s’ouvrir, puis acceptez l’accès demandé. Cette page se mettra à jour d’elle-même.`}
      </p>
      <a
        href={url}
        target="mf-oauth"
        className={cn(
          'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm',
          blocked
            ? 'mf-btn-primary bg-accent font-medium text-on-accent hover:opacity-90'
            : 'mf-btn border border-line hover:bg-surface-hover',
        )}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        {blocked
          ? `Ouvrir la connexion ${providerName}`
          : IN_DESKTOP_APP
            ? 'Rouvrir la connexion dans le navigateur'
            : 'Rouvrir la fenêtre de connexion'}
      </a>
    </div>
  );
}

function GoogleAppHelp({
  redirectUri,
  clientId,
  clientSecret,
  onClientId,
  onClientSecret,
}: {
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  onClientId: (value: string) => void;
  onClientSecret: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3">
      <p className="text-sm font-medium">Déclarer Pli chez Google (une seule fois)</p>
      <ol className="ml-4 list-decimal space-y-1 text-xs leading-relaxed text-ink-muted">
        <li>
          Sur console.cloud.google.com, créez un projet, puis activez l’API Gmail dans « API et
          services ».
        </li>
        <li>
          Dans « Écran de consentement OAuth », choisissez le type Externe et ajoutez votre adresse
          parmi les utilisateurs test.
        </li>
        <li>
          Dans « Identifiants », créez un « ID client OAuth » de type Application Web, avec cette
          adresse de redirection autorisée :
          <code className="mt-1 block rounded bg-surface-hover px-2 py-1 font-mono text-ink select-all">
            {redirectUri}
          </code>
        </li>
        <li>Copiez l’ID client et le code secret ci-dessous.</li>
      </ol>
      <p className="text-xs leading-relaxed text-ink-muted">
        Tant que l’application reste en mode « Test », Google demande de renouveler l’autorisation
        tous les sept jours.
      </p>
      <Field label="ID client">
        <input
          value={clientId}
          onChange={(e) => onClientId(e.target.value)}
          placeholder="…apps.googleusercontent.com"
          className={INPUT}
        />
      </Field>
      <Field label="Code secret du client">
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => onClientSecret(e.target.value)}
          className={INPUT}
        />
      </Field>
    </div>
  );
}

function ServerFields({
  title,
  value,
  onChange,
}: {
  title: string;
  value: ServerSettings;
  onChange: (next: ServerSettings) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-ink-muted">{title}</legend>
      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <input
          aria-label={`${title} : serveur`}
          value={value.host}
          onChange={(e) => onChange({ ...value, host: e.target.value })}
          className={INPUT}
        />
        <input
          aria-label={`${title} : port`}
          type="number"
          min={1}
          max={65535}
          value={value.port}
          onChange={(e) => onChange({ ...value, port: Number(e.target.value) })}
          className={INPUT}
        />
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted select-none">
        <input
          type="checkbox"
          checked={value.secure}
          onChange={(e) => onChange({ ...value, secure: e.target.checked })}
          className="size-3.5 accent-[var(--color-accent)]"
        />
        Connexion chiffrée dès l’ouverture (SSL/TLS, ports 993 et 465). Décochée : STARTTLS (port
        587).
      </label>
    </fieldset>
  );
}

function TestResult({ result }: { result: { imap: string | null; smtp: string | null } }) {
  const rows = [
    { name: 'Réception (IMAP)', error: result.imap },
    { name: 'Envoi (SMTP)', error: result.smtp },
  ];
  return (
    <ul className="flex flex-col gap-1.5 text-sm" aria-live="polite">
      {rows.map((row) => (
        <li key={row.name} className="flex gap-2 leading-relaxed">
          {row.error ? (
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          ) : (
            <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          )}
          <span>
            <span className="font-medium">{row.name}</span>
            <span className="text-ink-muted"> : {row.error ?? 'connexion réussie.'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Radio({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer gap-2.5 rounded-md p-1.5 hover:bg-surface-hover">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-1 size-3.5 shrink-0 accent-[var(--color-accent)]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        <span className="text-xs leading-relaxed text-ink-muted">{hint}</span>
      </span>
    </label>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-ink-muted">{hint}</span>}
    </label>
  );
}

const INPUT =
  'mf-input h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none placeholder:text-ink-muted focus:border-accent';
