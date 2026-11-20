import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Baseline,
  Bold,
  Highlighter,
  Italic,
  Link,
  Link2Off,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from './icons';
import { FONT_FAMILIES, FONT_SIZES, HIGHLIGHT_COLORS, TEXT_COLORS, safeHref } from '../lib/composeBody';
import { cn } from '../lib/utils';

type Popover = 'color' | 'highlight' | 'link' | null;

interface Props {
  editor: Editor;
  /** Incremented by Ctrl+K in the editor. */
  linkRequest: number;
}

export default function ComposerToolbar({ editor, linkRequest }: Props) {
  const [popover, setPopover] = useState<Popover>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const style = current.getAttributes('textStyle');
      return {
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        underline: current.isActive('underline'),
        strike: current.isActive('strike'),
        link: current.isActive('link'),
        href: (current.getAttributes('link').href as string | undefined) ?? '',
        color: (style.color as string | undefined) ?? '',
        backgroundColor: (style.backgroundColor as string | undefined) ?? '',
        fontFamily: (style.fontFamily as string | undefined) ?? '',
        fontSize: (style.fontSize as string | undefined) ?? '',
      };
    },
  });

  useEffect(() => {
    if (linkRequest > 0) setPopover('link');
  }, [linkRequest]);

  useEffect(() => {
    if (!popover) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as globalThis.Node)) setPopover(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPopover(null);
      editor.commands.focus();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [popover, editor]);

  // Restyling a span while a <select> holds focus lets the browser collapse the
  // DOM selection, and ProseMirror reads that back. The selects therefore act on
  // the last range the user made inside the editor, not on the current one.
  const userRange = useRef({ from: editor.state.selection.from, to: editor.state.selection.to });
  useEffect(() => {
    const remember = () => {
      if (!editor.view.hasFocus()) return;
      const { from, to } = editor.state.selection;
      userRange.current = { from, to };
    };
    editor.on('selectionUpdate', remember);
    editor.on('focus', remember);
    return () => {
      editor.off('selectionUpdate', remember);
      editor.off('focus', remember);
    };
  }, [editor]);

  const toggle = (next: Exclude<Popover, null>) => setPopover((current) => (current === next ? null : next));
  const chain = () => editor.chain().focus();
  const rangeChain = () => {
    const size = editor.state.doc.content.size;
    const from = Math.min(userRange.current.from, size);
    const to = Math.min(userRange.current.to, size);
    return editor.chain().focus().setTextSelection({ from, to });
  };

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Mise en forme"
      className="mf-toolbar relative flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5"
    >
      <select
        aria-label="Police"
        title="Police"
        value={state.fontFamily}
        onChange={(event) =>
          event.target.value
            ? rangeChain().setFontFamily(event.target.value).run()
            : rangeChain().unsetFontFamily().run()
        }
        className="mf-select h-7 cursor-pointer rounded-md bg-transparent px-1.5 text-xs text-ink-muted outline-none hover:bg-surface-hover hover:text-ink"
      >
        <option value="">Police par défaut</option>
        {FONT_FAMILIES.map((font) => (
          <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>
            {font.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Taille"
        title="Taille"
        value={state.fontSize}
        onChange={(event) =>
          event.target.value
            ? rangeChain().setFontSize(event.target.value).run()
            : rangeChain().unsetFontSize().run()
        }
        className="mf-select h-7 cursor-pointer rounded-md bg-transparent px-1.5 text-xs text-ink-muted outline-none hover:bg-surface-hover hover:text-ink"
      >
        <option value="">Taille normale</option>
        {FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size.replace('px', '')}
          </option>
        ))}
      </select>

      <Separator />

      <ToolButton label="Gras (Ctrl+B)" active={state.bold} onClick={() => chain().toggleBold().run()}>
        <Bold className="size-4" />
      </ToolButton>
      <ToolButton label="Italique (Ctrl+I)" active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic className="size-4" />
      </ToolButton>
      <ToolButton
        label="Souligné (Ctrl+U)"
        active={state.underline}
        onClick={() => chain().toggleUnderline().run()}
      >
        <Underline className="size-4" />
      </ToolButton>
      <ToolButton label="Barré" active={state.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough className="size-4" />
      </ToolButton>

      <Separator />

      <ToolButton label="Couleur du texte" active={popover === 'color'} onClick={() => toggle('color')}>
        <span className="flex flex-col items-center">
          <Baseline className="size-4" />
          <span
            className="-mt-0.5 h-0.5 w-3.5 rounded-sm"
            style={{ background: state.color || 'currentColor' }}
          />
        </span>
      </ToolButton>
      <ToolButton label="Surlignage" active={popover === 'highlight'} onClick={() => toggle('highlight')}>
        <span className="flex flex-col items-center">
          <Highlighter className="size-4" />
          <span
            className="-mt-0.5 h-0.5 w-3.5 rounded-sm"
            style={{ background: state.backgroundColor || 'transparent' }}
          />
        </span>
      </ToolButton>

      <Separator />

      <ToolButton label="Lien (Ctrl+K)" active={state.link || popover === 'link'} onClick={() => toggle('link')}>
        <Link className="size-4" />
      </ToolButton>
      {state.link && (
        <ToolButton label="Retirer le lien" onClick={() => chain().extendMarkRange('link').unsetLink().run()}>
          <Link2Off className="size-4" />
        </ToolButton>
      )}
      <ToolButton
        label="Effacer la mise en forme"
        onClick={() => chain().unsetAllMarks().run()}
      >
        <RemoveFormatting className="size-4" />
      </ToolButton>

      {popover === 'color' && (
        <Swatches
          colors={TEXT_COLORS}
          current={state.color}
          resetLabel="Couleur automatique"
          onPick={(color) => {
            chain().setColor(color).run();
            setPopover(null);
          }}
          onReset={() => {
            chain().unsetColor().run();
            setPopover(null);
          }}
        />
      )}
      {popover === 'highlight' && (
        <Swatches
          colors={HIGHLIGHT_COLORS}
          current={state.backgroundColor}
          resetLabel="Sans surlignage"
          onPick={(color) => {
            chain().setBackgroundColor(color).run();
            setPopover(null);
          }}
          onReset={() => {
            chain().unsetBackgroundColor().run();
            setPopover(null);
          }}
        />
      )}
      {popover === 'link' && (
        <LinkForm
          initial={state.href}
          onApply={(href) => {
            const { empty } = editor.state.selection;
            if (empty && !state.link) {
              chain()
                .insertContent({
                  type: 'text',
                  text: href.replace(/^mailto:/i, ''),
                  marks: [{ type: 'link', attrs: { href } }],
                })
                .run();
            } else {
              chain().extendMarkRange('link').setLink({ href }).run();
            }
            setPopover(null);
          }}
        />
      )}
    </div>
  );
}

function Separator() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />;
}

function ToolButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // Keeps the editor's selection: a button that takes focus would format nothing.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'mf-icon-btn flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink',
        active && 'bg-surface-hover text-ink',
      )}
    >
      {children}
    </button>
  );
}

function Swatches({
  colors,
  current,
  resetLabel,
  onPick,
  onReset,
}: {
  colors: readonly string[];
  current: string;
  resetLabel: string;
  onPick: (color: string) => void;
  onReset: () => void;
}) {
  return (
    // Largeur dictée par le contenu : la police d'un thème ne doit pas pouvoir
    // couper « Couleur automatique » en deux lignes.
    <div className="mf-popover absolute top-full left-2 z-10 mt-1 w-max min-w-52 rounded-md border border-line bg-surface p-2 shadow-2xl">
      <div className="grid grid-cols-8 justify-items-center gap-1">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={color}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(color)}
            className={cn(
              'size-5 cursor-pointer rounded-sm border border-black/20',
              current.toLowerCase() === color && 'ring-2 ring-accent ring-offset-1 ring-offset-surface',
            )}
            style={{ background: color }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs whitespace-nowrap">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onReset}
          className="mf-icon-btn cursor-pointer rounded-sm px-1.5 py-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          {resetLabel}
        </button>
        <label className="mf-icon-btn flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-ink-muted hover:bg-surface-hover hover:text-ink">
          Autre
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(current) ? current : '#000000'}
            onChange={(event) => onPick(event.target.value)}
            className="size-5 cursor-pointer border-0 bg-transparent p-0"
          />
        </label>
      </div>
    </div>
  );
}

function LinkForm({ initial, onApply }: { initial: string; onApply: (href: string) => void }) {
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function submit() {
    const href = safeHref(value);
    if (!href) {
      setInvalid(true);
      return;
    }
    onApply(href);
  }

  return (
    <div className="mf-popover absolute top-full left-2 z-10 mt-1 flex w-80 items-center gap-2 rounded-md border border-line bg-surface p-2 shadow-2xl">
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          submit();
        }}
        placeholder="https://… ou adresse e-mail"
        aria-invalid={invalid}
        className={cn(
          'min-w-0 flex-1 rounded-sm border bg-canvas px-2 py-1 text-sm outline-none',
          invalid ? 'border-warn' : 'mf-input border-line focus:border-accent',
        )}
      />
      <button
        type="button"
        onClick={submit}
        className="mf-btn-primary cursor-pointer rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:opacity-90"
      >
        OK
      </button>
    </div>
  );
}
