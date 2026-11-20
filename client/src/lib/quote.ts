import { format } from 'date-fns';

/** A reply or forward subject already carrying a prefix must not gain a second one. */
const REPLY_PREFIX = /^re\s*:/i;
const FORWARD_PREFIX = /^(?:tr|fwd|fw)\s*:/i;

function formatSent(timestamp: number, pattern: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'date inconnue';
  return format(date, pattern);
}

function party(person: { name?: string; address?: string } | null | undefined): string {
  const name = person?.name?.trim();
  const address = person?.address?.trim();
  if (name && address && name.toLowerCase() !== address.toLowerCase()) {
    return `${name} <${address}>`;
  }
  return address || name || 'inconnu';
}

function partyList(people: { name?: string; address?: string }[]): string {
  return people
    .map((person) => party(person))
    .filter((label) => label !== 'inconnu')
    .join(', ');
}

function quotedLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Attribution line for a reply. The date is the original message's, not today's. */
export function replyQuote(text: string, author: string, sentAt: number): string {
  const who = author.trim() || 'inconnu';
  const when = formatSent(sentAt, 'dd/MM/yyyy');
  return `\n\nLe ${when}, ${who} a écrit :\n${quotedLines(text)}`;
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (REPLY_PREFIX.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (FORWARD_PREFIX.test(trimmed)) return trimmed;
  return `Tr: ${trimmed}`;
}

export function forwardQuote(message: {
  text: string | null;
  subject: string;
  date: number;
  from: { name?: string; address?: string } | null;
  to: { name?: string; address?: string }[];
  cc: { name?: string; address?: string }[];
}): string {
  const lines = [
    `De : ${party(message.from)}`,
    `Date : ${formatSent(message.date, "dd/MM/yyyy 'à' HH:mm")}`,
    `Objet : ${message.subject.trim() || '(sans objet)'}`,
    `À : ${partyList(message.to) || 'inconnu'}`,
  ];
  const cc = partyList(message.cc);
  if (cc) lines.push(`Cc : ${cc}`);

  const body = message.text?.trim() ? `\n\n${quotedLines(message.text)}` : '';
  return `\n\n-------- Message transféré --------\n${lines.join('\n')}${body}`;
}
