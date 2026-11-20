import type { QueryClient } from '@tanstack/react-query';
import { api, type MessageSummary } from './api';

/**
 * Préchargement du corps des mails visibles à l'écran, pour supprimer l'attente
 * « Téléchargement… » à l'ouverture.
 *
 * Un mail complet peut peser plusieurs mégaoctets, et le serveur le récupère
 * intégralement, pièces jointes comprises. Précharger sans limite reviendrait à
 * télécharger la boîte en faisant défiler la liste. D'où quatre garde-fous :
 *
 *  - **délai de stabilité** : un mail doit rester visible un moment avant d'être
 *    demandé, sinon un défilement rapide déclencherait tout au passage ;
 *  - **deux téléchargements simultanés au plus**, pour ne pas concurrencer
 *    l'ouverture d'un mail réellement demandé par l'utilisateur ;
 *  - **plafond de taille** : au-delà, le gain ne vaut pas la bande passante ;
 *  - **budget par session**, qui borne le pire cas quoi qu'il arrive.
 */

const DWELL_MS = 400;
const MAX_CONCURRENT = 2;
const MAX_SIZE_BYTES = 2_000_000;
const SESSION_BUDGET = 300;

export class Prefetcher {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queued = new Set<string>();
  /** Mails déjà partis dans la file, mais sortis de l'écran avant le téléchargement. */
  private readonly skipped = new Set<string>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  private spent = 0;
  private stopped = false;

  constructor(private readonly queryClient: QueryClient) {}

  private static key(accountId: string, message: MessageSummary) {
    return `${accountId}:${message.folder}:${message.uid}`;
  }

  /** Le mail est entré dans la zone visible : on arme le préchargement. */
  enter(accountId: string, message: MessageSummary) {
    const key = Prefetcher.key(accountId, message);
    if (this.stopped || this.queued.has(key) || this.pending.has(key)) return;
    // `spent` n'avance qu'au démarrage réel. Compter aussi les attentes, sinon
    // un défilement lent empile des centaines de téléchargements avant que le
    // plafond de session ait eu le temps de se fermer.
    if (this.spent + this.pending.size + this.queued.size >= SESSION_BUDGET) return;
    if (message.size !== null && message.size > MAX_SIZE_BYTES) return;

    // Déjà en cache : rien à faire, et surtout rien à consommer du budget.
    const cached = this.queryClient.getQueryData([
      'message',
      accountId,
      message.folder,
      message.uid,
    ]);
    if (cached) return;

    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.run(key, accountId, message);
      }, DWELL_MS),
    );
  }

  /** Le mail a quitté l'écran avant le délai : on annule. */
  leave(accountId: string, message: MessageSummary) {
    const key = Prefetcher.key(accountId, message);
    const timer = this.pending.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(key);
      return;
    }
    // Déjà en file : ne pas lancer le téléchargement quand un créneau se libère.
    if (this.queued.has(key)) this.skipped.add(key);
  }

  private async run(key: string, accountId: string, message: MessageSummary) {
    this.queued.add(key);

    try {
      if (this.active >= MAX_CONCURRENT) {
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      }
      if (this.stopped || this.skipped.has(key) || this.spent >= SESSION_BUDGET) {
        this.skipped.delete(key);
        this.queued.delete(key);
        return;
      }

      this.active += 1;
      this.spent += 1;

      try {
        await this.queryClient.prefetchQuery({
          queryKey: ['message', accountId, message.folder, message.uid],
          queryFn: () => api.message(accountId, message.folder, message.uid),
          // Un corps de mail ne change pas : une fois chargé, il n'est jamais
          // redemandé tant qu'il reste en cache.
          staleTime: Infinity,
          // Au-delà, le corps quitte la mémoire. L'ouverture le rechargera.
          gcTime: 5 * 60_000,
        });
      } catch {
        // Un préchargement raté n'est pas un incident : le mail sera simplement
        // téléchargé à l'ouverture, comme avant.
        this.queued.delete(key);
        this.spent -= 1;
      } finally {
        this.active -= 1;
        this.skipped.delete(key);
      }
    } finally {
      this.waiting.shift()?.();
    }
  }

  dispose() {
    this.stopped = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.skipped.clear();
    // Réveille les attentes pour qu'elles constatent l'arrêt et sortent.
    const pending = this.waiting.splice(0);
    for (const release of pending) release();
  }
}
