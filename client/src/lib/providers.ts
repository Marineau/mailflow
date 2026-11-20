import type { ServerSettings } from './api';

/**
 * The mail providers offered by the « add an account » form, with their
 * server settings pre-filled. Nothing here is required by the server: « other »
 * takes any IMAP/SMTP box, and every field stays editable.
 *
 * `{domain}` in a host is replaced by the domain of the address typed.
 */
export type ProviderId = 'outlook' | 'gmail' | 'o2switch' | 'hostinger' | 'icloud' | 'other';

export interface ProviderPreset {
  id: ProviderId;
  name: string;
  /** One line under the name on the choice card. */
  blurb: string;
  /** How this provider logs in by default. Gmail can also use an app password. */
  auth: 'microsoft' | 'google' | 'password';
  imap: ServerSettings;
  smtp: ServerSettings;
  /** Shown above the password field: where the password comes from. */
  passwordHint?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'outlook',
    name: 'Outlook.com',
    blurb: 'Outlook, Hotmail, Live : connexion par le compte Microsoft.',
    auth: 'microsoft',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  },
  {
    id: 'gmail',
    name: 'Gmail',
    blurb: 'Connexion par le compte Google, ou par mot de passe d’application.',
    auth: 'google',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    passwordHint:
      'Google refuse le mot de passe habituel. Créez un mot de passe d’application dans votre compte Google (Sécurité, Validation en deux étapes, Mots de passe des applications), puis collez-le ici.',
  },
  {
    id: 'o2switch',
    name: 'o2switch',
    blurb: 'Adresse sur votre propre domaine, hébergée chez o2switch.',
    auth: 'password',
    imap: { host: 'mail.{domain}', port: 993, secure: true },
    smtp: { host: 'mail.{domain}', port: 465, secure: true },
    passwordHint:
      'Le mot de passe de la boîte, tel que défini dans cPanel. Si la connexion échoue, le nom exact du serveur figure dans cPanel, rubrique Comptes de messagerie, « Connecter les appareils ».',
  },
  {
    id: 'hostinger',
    name: 'Hostinger',
    blurb: 'Adresse sur votre propre domaine, hébergée chez Hostinger.',
    auth: 'password',
    imap: { host: 'imap.hostinger.com', port: 993, secure: true },
    smtp: { host: 'smtp.hostinger.com', port: 465, secure: true },
    passwordHint: 'Le mot de passe de la boîte, tel que défini dans hPanel.',
  },
  {
    id: 'icloud',
    name: 'iCloud',
    blurb: 'Adresse iCloud.com, me.com ou mac.com.',
    auth: 'password',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    passwordHint:
      'Apple exige un mot de passe propre à l’app : créez-le sur account.apple.com, rubrique Connexion et sécurité.',
  },
  {
    id: 'other',
    name: 'Autre fournisseur',
    blurb: 'Toute boîte qui accepte IMAP et SMTP avec un mot de passe.',
    auth: 'password',
    imap: { host: 'imap.{domain}', port: 993, secure: true },
    smtp: { host: 'smtp.{domain}', port: 465, secure: true },
    passwordHint:
      'Les noms de serveurs proposés sont les plus courants ; votre fournisseur indique les siens dans son aide.',
  },
];

export function withDomain(settings: ServerSettings, email: string): ServerSettings {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
  return { ...settings, host: settings.host.replace('{domain}', domain || 'votre-domaine.fr') };
}
