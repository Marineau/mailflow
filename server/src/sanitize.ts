import sanitizeHtml from 'sanitize-html';
import { neutralizeRemoteCss } from './remoteCss.js';

/**
 * Version du nettoyage. Les corps en cache sont du HTML déjà nettoyé : quand
 * les règles changent, ceux d'avant gardent ce que l'ancienne version laissait
 * passer. Incrémenter ce nombre les fait vider au démarrage suivant
 * (`dropOutdatedBodies`), et chaque mail est renettoyé à sa prochaine ouverture.
 *
 *  1 — images distantes neutralisées (`<img src>` → `data-src`)
 *  2 — ressources distantes du CSS neutralisées (`remoteCss.ts`)
 */
export const SANITIZER_VERSION = 2;

/**
 * Empêche une feuille de se refermer toute seule. Le contenu d'un `<style>`
 * n'est filtré par personne : si l'analyseur de sanitize-html et celui du
 * navigateur cessaient de s'accorder sur ce qui termine la balise, ce que le
 * premier a pris pour du CSS serait lu par le second comme des balises.
 * Aucun désaccord trouvé le 2026-11-17 sur quatorze fins de balise tordues ;
 * sans `</`, la question ne dépend plus de la version de l'analyseur.
 * Dans une chaîne CSS, `<\/` vaut `</` ; ailleurs la séquence n'a aucun sens.
 */
function sealSheet(css: string): string {
  return css.replace(/<\//g, '<\\/');
}

/**
 * Un mail HTML est du contenu hostile par défaut. Deux menaces distinctes :
 *  - le script / les URL `javascript:` → supprimés ici ;
 *  - les ressources distantes, qui sont des mouchards de lecture → neutralisées,
 *    et que le client ne réactive que sur clic explicite. Une image devient
 *    `data-src` ; une adresse nommée dans le CSS (image de fond, `@import`,
 *    police) devient un `url()` inerte qui garde l'adresse d'origine.
 * Le rendu final se fait malgré tout dans une iframe sandboxée côté client :
 * l'assainissement est la première ligne, pas la seule.
 *
 * `blockedImages` compte tout ce que « Afficher » peut rétablir, CSS compris.
 */
export function sanitizeMailHtml(html: string): { html: string; blockedImages: number } {
  let blockedImages = 0;

  const clean = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'style',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      'center',
      'font',
      'span',
    ]),
    // `style` est une balise que sanitize-html signale à chaque appel : il ne
    // regarde pas dedans. C'est `neutralizeRemoteCss` qui le fait, plus bas ;
    // ce drapeau ne change rien d'autre que le silence de l'avertissement.
    allowVulnerableTags: true,
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'colspan', 'rowspan'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['data-src', 'src', 'alt', 'title', 'width', 'height', 'style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? '';
        // Les images inline (cid:, data:) sont déjà dans le mail : rien à fuiter.
        if (src.startsWith('cid:') || src.startsWith('data:')) {
          return { tagName, attribs };
        }
        if (src) {
          blockedImages += 1;
          const { src: _dropped, ...rest } = attribs;
          return { tagName, attribs: { ...rest, 'data-src': src } };
        }
        return { tagName, attribs };
      },
      // Passe après la transformation propre à la balise : l'attribut `style`
      // d'une image ou d'un lien est donc vu lui aussi.
      '*': (tagName, attribs) => {
        if (!attribs.style) return { tagName, attribs };
        const held = neutralizeRemoteCss(attribs.style);
        blockedImages += held.blocked;
        return { tagName, attribs: { ...attribs, style: held.css } };
      },
    },
  });

  // Le contenu d'un `<style>` ressort tel quel de sanitize-html, sans passer
  // par aucun filtre. En sortie les balises sont normalisées et tout `<` hors
  // balise est échappé : chaque `<style>…</style>` est bien une feuille, et
  // une feuille restée ouverte court jusqu'à la fin du texte.
  const held = clean.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>|$)/gi,
    (_match, open: string, css: string, close: string) => {
      const sheet = neutralizeRemoteCss(css);
      blockedImages += sheet.blocked;
      return open + sealSheet(sheet.css) + close;
    },
  );

  return { html: held, blockedImages };
}

/**
 * HTML → texte brut, **sans troncature**. C'est la fonction à utiliser pour
 * alimenter l'index de recherche : passer par `makeSnippet` couperait le corps
 * à 240 caractères et rendrait introuvable tout ce qui suit — soit la quasi
 * totalité d'un mail HTML.
 */
export function htmlToText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Aperçu de liste : texte brut, une seule ligne, coupé court. */
export function makeSnippet(text: string | undefined, html: string | undefined): string {
  const source = text ?? (html ? htmlToText(html) : '');
  return source.replace(/\s+/g, ' ').trim().slice(0, 240);
}
