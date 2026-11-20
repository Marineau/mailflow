import { Node, type Extensions, type JSONContent } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { BackgroundColor, Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { safeHref } from './composeBody';

/**
 * A screenshot pasted into the message. The `src` is a local blob URL for display;
 * the serializer replaces it with `cid:<id>`. It has no parse rule on purpose:
 * pasted HTML must never be able to smuggle an image in.
 */
export const InlineImage = Node.create({
  name: 'inlineImage',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: { default: null },
      src: { default: null },
      alt: { default: '' },
    };
  },

  parseHTML() {
    return [];
  },

  renderHTML({ node }) {
    return [
      'img',
      {
        'data-inline-id': node.attrs.id,
        src: node.attrs.src,
        alt: node.attrs.alt,
        draggable: 'false',
        class: 'mf-inline-shot',
      },
    ];
  },
});

/** Only what survives in mail clients: no headings, lists, code or rules in this version. */
export function composeExtensions(placeholder: string): Extensions {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: false,
        defaultProtocol: 'https',
        isAllowedUri: (url) => safeHref(url) !== null,
        HTMLAttributes: { rel: 'noopener noreferrer', target: null },
      },
    }),
    TextStyle,
    Color,
    BackgroundColor,
    FontFamily,
    FontSize,
    InlineImage,
    Placeholder.configure({ placeholder }),
  ];
}

export function textToDoc(text: string): JSONContent {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

export function inlineImageIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === InlineImage.name && typeof node.attrs.id === 'string') ids.add(node.attrs.id);
  });
  return ids;
}

/** Each pasted line becomes a paragraph, without any formatting from the source. */
export function insertPlainText(view: EditorView, text: string) {
  if (!text) return;
  const { schema } = view.state;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const paragraphs = lines.map((line) =>
    schema.nodes.paragraph.create(null, line ? schema.text(line) : null),
  );
  const slice = Slice.maxOpen(Fragment.from(paragraphs));
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
}

export function placeCaretAt(view: EditorView, clientX: number, clientY: number) {
  const hit = view.posAtCoords({ left: clientX, top: clientY });
  if (!hit) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.pos)));
}
