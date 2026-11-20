export interface TextPart {
  part: string;
  type: string;
  size: number;
  encoding: string;
  charset: string;
}

/**
 * Cherche la partie texte à indexer : `text/plain` d'abord, `text/html` sinon.
 *
 * Vit dans son propre module parce que deux passes s'en servent — la synchro
 * d'en-têtes, qui a déjà la structure sous la main, et l'indexation des corps,
 * qui préfère ne pas la redemander.
 */
export function findTextPart(node: unknown): TextPart | null {
  const found: TextPart[] = [];

  const walk = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return;
    const part = candidate as {
      part?: string;
      type?: string;
      size?: number;
      encoding?: string;
      parameters?: { charset?: string };
      disposition?: string;
      childNodes?: unknown[];
    };

    if (part.childNodes?.length) {
      for (const child of part.childNodes) walk(child);
      return;
    }

    const type = (part.type ?? '').toLowerCase();
    if (
      (type === 'text/plain' || type === 'text/html') &&
      part.disposition?.toLowerCase() !== 'attachment'
    ) {
      found.push({
        part: part.part ?? '1',
        type,
        size: part.size ?? 0,
        encoding: (part.encoding ?? '7bit').toLowerCase(),
        charset: (part.parameters?.charset ?? 'utf-8').toLowerCase(),
      });
    }
  };

  walk(node);

  return found.find((p) => p.type === 'text/plain') ?? found[0] ?? null;
}
