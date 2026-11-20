/**
 * Surbrillance des termes cherchés dans le corps d'un mail.
 *
 * Le HTML est analysé puis parcouru nœud de texte par nœud de texte, plutôt que
 * traité par expression régulière. Une regex sur du HTML brut surlignerait aussi
 * bien un mot dans un attribut `href` ou un nom de balise, cassant le document —
 * et sur du contenu tiers, ce genre de manipulation ne pardonne pas.
 */

const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'HEAD', 'TITLE']);

function splitTerms(query: string): string[] {
  return [...new Set(query.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2))];
}

export function highlightHtml(html: string, query: string): string {
  const terms = splitTerms(query);
  if (terms.length === 0) return html;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);

  // Le parcours est figé avant modification : remplacer des nœuds pendant
  // l'itération ferait sauter des occurrences au TreeWalker.
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement && SKIP_TAGS.has(node.parentElement.tagName)) continue;
    if (node.nodeValue?.trim()) targets.push(node);
  }

  for (const node of targets) {
    const text = node.nodeValue ?? '';
    const ranges = findRanges(text, terms);
    if (ranges.length === 0) continue;

    const fragment = doc.createDocumentFragment();
    let cursor = 0;

    for (const [start, end] of ranges) {
      if (start > cursor) fragment.appendChild(doc.createTextNode(text.slice(cursor, start)));
      const mark = doc.createElement('mark');
      mark.className = 'mf-hit';
      mark.textContent = text.slice(start, end);
      fragment.appendChild(mark);
      cursor = end;
    }

    if (cursor < text.length) fragment.appendChild(doc.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }

  // Un <style> en tête de fragment est hissé dans <head> par l'analyseur.
  // Sans ça la feuille — et les couleurs déjà adaptées au sombre — disparaît.
  const headStyles = [...doc.head.querySelectorAll('style')].map((el) => el.outerHTML).join('');
  return headStyles + doc.body.innerHTML;
}

/** Positions des occurrences, fusionnées et ordonnées pour éviter les chevauchements. */
function findRanges(text: string, terms: string[]): [number, number][] {
  const haystack = text.toLowerCase();
  const ranges: [number, number][] = [];

  for (const term of terms) {
    const needle = term.toLowerCase();
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      ranges.push([index, index + needle.length]);
      from = index + needle.length;
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range] as [number, number]);
  }

  return merged;
}

/** Variante texte brut : renvoie du HTML échappé, avec les occurrences balisées. */
export function highlightText(text: string, query: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const terms = splitTerms(query);
  if (terms.length === 0) return escaped;

  const ranges = findRanges(escaped, terms);
  if (ranges.length === 0) return escaped;

  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += escaped.slice(cursor, start) + `<mark class="mf-hit">${escaped.slice(start, end)}</mark>`;
    cursor = end;
  }
  return out + escaped.slice(cursor);
}
