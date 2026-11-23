import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
  markdownLanguage,
} from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, Prec, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/**
 * The text editor in the pane (ADR-0070 §8): CodeMirror 6, with Markdown drawn
 * as it is written.
 *
 * **The document is the file's text, character for character.** A heading is
 * drawn large and bold as its line is typed, emphasis is drawn as emphasis, and
 * the marks that make them (`##`, `**`, a backtick) stay on screen, dimmed: what
 * is shown is what is saved, and the caret never jumps over a character it
 * cannot see. The one mark drawn otherwise is a bullet list's `-`, `*` or `+`,
 * shown as `•` because the owner asked for exactly that; it stays in the file
 * and the caret steps over it as the one character it is.
 *
 * **Enter continues a list** (`- `, `1. ` to `2. `, a task's `- [ ] `), and Enter
 * on an empty item ends it — `@codemirror/lang-markdown`'s own command, told not to loosen the list. Tab and
 * Shift+Tab indent.
 *
 * Every style is a class (`cm-md-*`) drawn by `preview.css`, so the tokens it
 * uses go through the same check as the rest of the window's.
 */

/** A bullet list's mark, drawn as a bullet. */
class Bullet extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const mark = document.createElement("span");
    mark.className = "cm-md-bullet";
    mark.textContent = "•";
    return mark;
  }
}

const BULLET = Decoration.replace({ widget: new Bullet() });

/** The heading levels, as the classes their lines carry. */
const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/**
 * Line classes for headings, quotes and code blocks, and bullets for list
 * marks, over what is on screen. Rebuilt as the text or the view moves, which
 * is what makes a line grow the moment `## ` is typed.
 */
function decorate(view: EditorView): { all: DecorationSet; bullets: DecorationSet } {
  const all: Range<Decoration>[] = [];
  const bullets: Range<Decoration>[] = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const heading = HEADING.exec(node.name);
        const lineClass =
          heading !== null
            ? `cm-md-h${heading[1]}`
            : node.name === "Blockquote"
              ? "cm-md-quote-line"
              : node.name === "FencedCode" || node.name === "CodeBlock"
                ? "cm-md-code-line"
                : undefined;
        if (lineClass !== undefined) {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(Math.max(node.from, node.to - 1)).number;
          for (let line = first; line <= last; line += 1) {
            all.push(Decoration.line({ class: lineClass }).range(doc.line(line).from));
          }
        }
        if (node.name === "ListMark" && node.node.parent?.parent?.name === "BulletList") {
          const bullet = BULLET.range(node.from, node.to);
          all.push(bullet);
          bullets.push(bullet);
        }
      },
    });
  }
  return { all: Decoration.set(all, true), bullets: Decoration.set(bullets, true) };
}

const markdownLook = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    bullets: DecorationSet;

    constructor(view: EditorView) {
      ({ all: this.decorations, bullets: this.bullets } = decorate(view));
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        ({ all: this.decorations, bullets: this.bullets } = decorate(update.view));
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    // A bullet is one character in the file, so the caret takes it in one step.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.bullets ?? Decoration.none),
  },
);

/** Inline styles, as classes `preview.css` draws. */
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, class: "cm-md-heading" },
  { tag: tags.strong, class: "cm-md-strong" },
  { tag: tags.emphasis, class: "cm-md-emphasis" },
  { tag: tags.strikethrough, class: "cm-md-strike" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: tags.quote, class: "cm-md-quote" },
  // `##`, `**`, a list's number, a fence: the marks, dimmed.
  { tag: tags.processingInstruction, class: "cm-md-mark" },
  { tag: tags.contentSeparator, class: "cm-md-mark" },
]);

/** What a Markdown file is edited with, beyond what every text file gets. */
function markdownExtensions(): Extension {
  return [
    markdown({ base: markdownLanguage, addKeymap: false }),
    // The package's own Enter, told not to loosen a list: Enter in an empty
    // item ends the list, which is what the owner asked for, where by default
    // the first such Enter puts a blank line in and carries on.
    Prec.high(
      keymap.of([
        { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
        { key: "Backspace", run: deleteMarkupBackward },
      ]),
    ),
    syntaxHighlighting(markdownStyle),
    markdownLook,
  ];
}

export function SourceEditor({
  initial,
  markdown: isMarkdown,
  label,
  caret,
  onChange,
  onSave,
  onDone,
}: {
  /** The text it opens with. Read once: a reload remounts the editor. */
  readonly initial: string;
  readonly markdown: boolean;
  readonly label: string;
  /** Where the caret starts: where a click landed on the text being read. */
  readonly caret: number;
  readonly onChange: (text: string) => void;
  /** `Ctrl+S`. */
  readonly onSave: () => void;
  /** `Escape`. */
  readonly onDone: () => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  // The latest handlers, read when a key arrives: the editor is made once, and
  // handlers it captured at that moment would act on the first render's state.
  const handlers = useRef({ onChange, onSave, onDone });
  handlers.current = { onChange, onSave, onDone };

  // biome-ignore lint/correctness/useExhaustiveDependencies: made once per mount; see `initial`
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const at = Math.max(0, Math.min(caret, initial.length));
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial,
        selection: { anchor: at },
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  handlers.current.onSave();
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  handlers.current.onDone();
                  return true;
                },
              },
            ]),
          ),
          history(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": label,
            spellcheck: isMarkdown ? "true" : "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
          isMarkdown ? markdownExtensions() : [],
        ],
      }),
    });
    view.focus();
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
    return () => view.destroy();
  }, []);

  return (
    // The keys are the editor's while it has them: an arrow moves the caret
    // rather than stepping to the next asset, and nothing in the window reads a
    // key typed into a file.
    // biome-ignore lint/a11y/noStaticElementInteractions: a container; the editor inside it is the textbox
    <div className="text-source" ref={host} onKeyDown={(event) => event.stopPropagation()} />
  );
}
