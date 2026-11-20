import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, isThisYear, isToday } from 'date-fns';
import { fr } from 'date-fns/locale';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format compact pour la liste : l'heure aujourd'hui, la date sinon. */
export function formatListDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (isToday(date)) return format(date, 'HH:mm');
  if (isThisYear(date)) return format(date, 'd MMM', { locale: fr });
  return format(date, 'dd/MM/yy');
}

export function formatFullDate(timestamp: number): string {
  return format(new Date(timestamp), "EEEE d MMMM yyyy 'à' HH:mm", { locale: fr });
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/** Adresse utilisable pour un blocage, ou null si l'enveloppe n'en a pas. */
export function senderAddress(address: string | undefined): string | null {
  const value = address?.trim().toLowerCase() ?? '';
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) return null;
  return value;
}

export function displayName(from: { name?: string; address?: string }): string {
  return from.name || from.address || 'Inconnu';
}

/** Nom et adresse, pour qu'un destinataire reste identifiable même sans nom. */
export function formatParty(person: { name?: string; address?: string }): string {
  const name = person.name?.trim();
  const address = person.address?.trim();
  if (name && address && name.toLowerCase() !== address.toLowerCase()) {
    return `${name} <${address}>`;
  }
  return address || name || 'Inconnu';
}

/** Liste lisible des destinataires. Vide si l'enveloppe n'a pas de champ À. */
export function recipientsLabel(
  people: { name?: string; address?: string }[] | undefined,
): string {
  const labels = (people ?? []).map(formatParty).filter((label) => label !== 'Inconnu');
  return labels.length > 0 ? labels.join(', ') : 'destinataire inconnu';
}

const OUTBOUND_NAMES = new Set([
  'sent',
  'sent items',
  'envoyés',
  'éléments envoyés',
  'elements envoyes',
  'drafts',
  'brouillons',
]);

/** Envoyés et brouillons : l'expéditeur, c'est soi-même. On affiche le destinataire. */
export function isOutboundFolder(folder: { name: string; specialUse: string | null }): boolean {
  if (folder.specialUse === '\\Sent' || folder.specialUse === '\\Drafts') return true;
  return OUTBOUND_NAMES.has(folder.name.toLowerCase());
}

export function initials(from: { name?: string; address?: string }): string {
  const source = from.name || from.address || '?';
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase();
}

const FOLDER_LABELS: Record<string, string> = {
  '\\Inbox': 'Boîte de réception',
  '\\Sent': 'Envoyés',
  '\\Drafts': 'Brouillons',
  '\\Trash': 'Corbeille',
  '\\Junk': 'Indésirables',
  '\\Archive': 'Archives',
};

export function folderLabel(folder: { name: string; specialUse: string | null }): string {
  if (folder.specialUse && FOLDER_LABELS[folder.specialUse]) {
    return FOLDER_LABELS[folder.specialUse];
  }
  if (folder.name.toUpperCase() === 'INBOX') return 'Boîte de réception';
  return folder.name;
}

/** Key of the indexing progress map: a folder path alone is not unique across accounts. */
export function indexKey(account: string, path: string): string {
  return `${account}\u0000${path}`;
}
