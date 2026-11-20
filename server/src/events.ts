export interface AppEvent {
  type: 'exists' | 'flags' | 'index' | 'progress';
  account: string;
  path?: string;
  /** Request the progress belongs to (`X-Mailflow-Op`), only on `type: 'progress'`. */
  op?: string;
  /** Checkpoint of a long request — see progress.ts. */
  progress?: { at: number; next: number; eta?: number };
  /** Progression d'indexation, uniquement sur `type: 'index'`. */
  index?: {
    phase: 'headers' | 'bodies' | 'idle' | 'done' | 'error';
    done: number;
    total: number;
    message?: string;
  };
}

type Listener = (event: AppEvent) => void;

const listeners = new Set<Listener>();

export function onAppEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitAppEvent(event: AppEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // Un client SSE déjà parti ne doit pas empêcher les autres d'être servis,
      // ni remonter dans l'indexation qui émet ces événements.
      console.error(`[events] ${(err as Error).message}`);
    }
  }
}
