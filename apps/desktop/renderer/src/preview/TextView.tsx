import type { WireAssetDetail, WireText } from "@roost/contract";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../bridge.js";
import { followableLink, renderMarkdown } from "./markdown.js";
import { SourceEditor } from "./SourceEditor.js";

/**
 * Markdown and plain text, read and edited in the pane (ADR-0070 §3.2).
 *
 * **Read first, then edit.** A `.md` is drawn rendered and a `.txt` as text; a
 * **click on the text**, **Edit** or `E` opens the editor (`SourceEditor`, ADR-0070
 * §8), with the caret where the click landed. A click on a link opens the link,
 * and a drag that selects text stays a selection. **Save** (`Ctrl+S`) writes over
 * the file and stays, and **Done** (`Escape`) goes back to reading. Reading first
 * is what keeps the pane's keys — the arrows step to the next asset — working on
 * a text file.
 *
 * **There is no Save button: leaving saves** (ADR-0070 §9). Done, `Escape`,
 * stepping to the next asset and closing the pane each write the edit first,
 * and any other way out — a sidebar row, a search — writes it as the editor
 * goes. `Ctrl+S` still saves on the spot. A save refused because the file
 * changed on disk keeps the editor open, with Reload and Save anyway.
 *
 * The text comes from the engine (`asset:readText`), decoded and at most 2 MiB,
 * never over `roost://`, which the renderer may not `fetch()`. A save carries
 * back the size and modification time the file was read with, and the engine
 * refuses it when somebody saved the file elsewhere meanwhile; the pane then
 * offers to reload or to save anyway.
 */

/** What the pane asks of the text on screen. */
export interface TextHandle {
  /** Starts editing, where the file may be edited. */
  readonly edit: () => void;
  /** Whether leaving now would lose an edit. */
  readonly dirty: () => boolean;
  /** Saves the edit, and answers whether it was written. */
  readonly save: () => Promise<boolean>;
}

type Readable = Extract<WireText, { kind: "text" }>;

/** The text as a `<textarea>` holds it: a textarea gives back `\n` only. */
function asEdited(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function TextView({
  detail,
  tools,
  editOnOpen,
  saveThen,
  ref,
}: {
  readonly detail: WireAssetDetail;
  /** The head's slot, which Edit and Done are drawn into. */
  readonly tools: HTMLElement | null;
  /** Opens straight into Edit: a Markdown file somebody has just made. */
  readonly editOnOpen: boolean;
  /** Saves any unsaved edit, then runs `then`; does not run it when the save was refused. */
  readonly saveThen: (then: () => void) => void;
  readonly ref?: React.Ref<TextHandle>;
}): React.JSX.Element {
  const [read, setRead] = useState<WireText | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  /** Where the editor's caret starts, and a count that remounts it on Reload. */
  const [caret, setCaret] = useState(0);
  const [mount, setMount] = useState(0);
  /** The draft as typed, read by a save that may run before React re-renders. */
  const typed = useRef("");
  const opened = useRef(false);
  const markdown = /^(md|markdown)$/i.test(detail.ext);

  const load = useCallback(async (): Promise<WireText | undefined> => {
    const answer = await invoke({ type: "asset:readText", id: detail.id });
    if (!answer.ok) {
      setFailed(answer.problem.message);
      return undefined;
    }
    setFailed(undefined);
    setRead(answer.value);
    return answer.value;
  }, [detail.id]);

  const readable = read?.kind === "text" ? read : undefined;
  const editable = readable?.editable === true;

  // Read again when the file changed and nobody is editing it: the watcher
  // re-derives a file saved elsewhere, and its derive time moves (ADR-0047). An
  // edit in progress is left alone, and the save's check is what catches it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the derive time is the trigger
  useEffect(() => {
    if (editing) return;
    void (async () => {
      const answer = await load();
      if (opened.current || !editOnOpen) return;
      opened.current = true;
      if (answer?.kind === "text" && answer.editable) {
        const text = asEdited(answer.text);
        setDraft(text);
        typed.current = text;
        setCaret(text.length);
        setEditing(true);
      }
    })();
  }, [load, detail.derivedAt]);

  const startEditing = useCallback(
    (at = 0) => {
      if (readable === undefined || !readable.editable) return;
      const text = asEdited(readable.text);
      setDraft(text);
      typed.current = text;
      setCaret(at);
      setConflict(false);
      setEditing(true);
    },
    [readable],
  );

  const typedInto = useCallback((text: string) => {
    typed.current = text;
    setDraft(text);
  }, []);

  const save = useCallback(
    async (force = false): Promise<boolean> => {
      if (readable === undefined) return false;
      const text = typed.current;
      setSaving(true);
      const answer = await invoke({
        type: "asset:saveText",
        id: detail.id,
        text,
        size: readable.size,
        mtimeMs: readable.mtimeMs,
        bom: readable.encoding === "utf-8-bom",
        crlf: readable.crlf,
        force,
      });
      setSaving(false);
      if (!answer.ok) {
        if (answer.problem.code === "changed_on_disk") setConflict(true);
        else setFailed(answer.problem.message);
        return false;
      }
      setConflict(false);
      // What is on disk now is what was typed, under the size and time the next
      // save checks against.
      setRead({ ...readable, text, ...answer.value });
      // Saved before the pane closes or steps, which unmounts this before it
      // renders again: the save on the way out must not run a second time.
      leaving.current = { ...leaving.current, readable: { ...readable, text, ...answer.value } };
      return true;
    },
    [detail.id, readable],
  );

  const done = useCallback(() => saveThen(() => setEditing(false)), [saveThen]);

  // What a save on the way out needs, read when the view is already going: an
  // unmount has no render left to read state from.
  // Read against what was typed rather than `draft`, which may not have been
  // rendered yet when the view goes.
  const leaving = useRef({ editing, readable, id: detail.id });
  leaving.current = { editing, readable, id: detail.id };
  // Any way out the pane did not save on — a sidebar row, a search, a library
  // closed — saves as the editor goes (ADR-0070 §9). Without the size and time
  // check waived: an edit that would undo somebody else's save is not written,
  // and there is nobody left on screen to ask.
  useEffect(
    () => () => {
      const { editing: open, readable: file, id } = leaving.current;
      if (!open || file === undefined || typed.current === asEdited(file.text)) return;
      void invoke({
        type: "asset:saveText",
        id,
        text: typed.current,
        size: file.size,
        mtimeMs: file.mtimeMs,
        bom: file.encoding === "utf-8-bom",
        crlf: file.crlf,
        force: false,
      });
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      edit: () => startEditing(),
      // From what was typed, for the same reason as the save on the way out.
      dirty: () => {
        const { editing: open, readable: file } = leaving.current;
        return open && file !== undefined && typed.current !== asEdited(file.text);
      },
      save: () => save(),
    }),
    [startEditing, save],
  );

  const html = useMemo(
    () => (readable !== undefined && markdown ? renderMarkdown(readable.text) : ""),
    [readable, markdown],
  );

  const buttons =
    tools === null || readable === undefined
      ? null
      : createPortal(
          editing ? (
            <button
              type="button"
              disabled={saving}
              title="Save and stop editing (Esc)"
              onClick={done}
            >
              {saving ? "Saving…" : "Done"}
            </button>
          ) : (
            <button
              type="button"
              disabled={!editable}
              title={editable ? "Edit (E)" : notEditable(readable)}
              onClick={() => startEditing()}
            >
              Edit
            </button>
          ),
          tools,
        );

  if (failed !== undefined) return <p className="text-note">{failed}</p>;
  if (read === undefined) return <div className="text-view" />;
  if (read.kind !== "text") {
    return (
      <div className="preview-fallback">
        <p>
          {read.kind === "binary"
            ? `This ${detail.ext} holds something other than text.`
            : "The file is missing from the library."}
        </p>
        <button
          type="button"
          data-variant="primary"
          onClick={() => void invoke({ type: "asset:openExternally", id: detail.id })}
        >
          Open externally
        </button>
      </div>
    );
  }

  return (
    <div className="text-view">
      {buttons}
      {conflict && (
        <div className="text-conflict" role="alert">
          <span>This file was changed in another application after it was opened.</span>
          <button
            type="button"
            onClick={() =>
              void (async () => {
                const answer = await load();
                if (answer?.kind === "text") {
                  typedInto(asEdited(answer.text));
                  setMount((count) => count + 1);
                }
                setConflict(false);
              })()
            }
          >
            Reload
          </button>
          <button type="button" onClick={() => void save(true)}>
            Save anyway
          </button>
        </div>
      )}
      {editing ? (
        <SourceEditor
          key={mount}
          initial={draft}
          markdown={markdown}
          label={`Edit ${detail.name}`}
          caret={caret}
          onChange={typedInto}
          onSave={() => {
            if (!saving) void save();
          }}
          onDone={done}
        />
      ) : markdown ? (
        // The HTML is markdown-it's with `html: false`: everything the file
        // wrote is escaped, so nothing in it becomes an element of its own.
        // A link in it is reached by Tab and followed by Enter, which fires the
        // same click; the handler only redirects where that click goes.
        // biome-ignore lint/a11y/useKeyWithClickEvents: see above
        // biome-ignore lint/a11y/noStaticElementInteractions: see above
        <div
          className="text-markdown"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by markdown-it, see above
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(event) => {
            const target = event.target instanceof Element ? event.target.closest("a") : null;
            if (target === null) {
              if (!editable || selecting()) return;
              return startEditing(markdownCaret(event, asEdited(read.text)));
            }
            // Never navigated in the window (invariant 11): an `http(s)` link
            // opens in the system's browser, and anything else does nothing.
            event.preventDefault();
            const url = followableLink(event.target);
            if (url !== undefined) void invoke({ type: "link:open", url });
          }}
        />
      ) : (
        // biome-ignore lint/a11y/useKeyWithClickEvents: `E` and Edit are the keyboard's way in
        <pre
          className="text-plain"
          onClick={(event) => {
            if (!editable || selecting()) return;
            startEditing(plainCaret(event));
          }}
        >
          {asEdited(read.text)}
        </pre>
      )}
      {(read.truncated || read.encoding !== "utf-8") && !editing && (
        <p className="text-note">{readNote(read)}</p>
      )}
    </div>
  );
}

/**
 * Whether the click ended a drag that selected text, which stays a selection
 * rather than opening the editor (ADR-0070 §8.1).
 */
function selecting(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== "";
}

/** The text node and offset under a click, where the browser can say. */
function pointAt(event: React.MouseEvent): { node: Node; offset: number } | undefined {
  // Chromium's spelling; the standard `caretPositionFromPoint` is newer there.
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range === null || range === undefined) return undefined;
  return { node: range.startContainer, offset: range.startOffset };
}

/**
 * Where the caret goes after a click on plain text: the same character, since
 * the `<pre>` holds the text as the editor will.
 */
function plainCaret(event: React.MouseEvent): number {
  const point = pointAt(event);
  const pre = event.currentTarget;
  if (point === undefined || !pre.contains(point.node)) return 0;
  // Everything before the point inside the `<pre>`, measured by a range.
  const before = document.createRange();
  before.setStart(pre, 0);
  before.setEnd(point.node, point.offset);
  return before.toString().length;
}

/**
 * Where the caret goes after a click on rendered Markdown.
 *
 * Rendered text is not the source, so this is a good guess rather than an
 * exact map: the block clicked carries the source line it came from
 * (`data-source-line`), and the few characters after the click are looked for
 * from there. Not found, the caret goes to the start of the block's line.
 */
function markdownCaret(event: React.MouseEvent, source: string): number {
  const target = event.target instanceof Element ? event.target : null;
  const block = target?.closest("[data-source-line]");
  const line = Number(block?.getAttribute("data-source-line") ?? "0");
  const lines = source.split("\n");
  let start = 0;
  for (let index = 0; index < line && index < lines.length; index += 1) {
    start += (lines[index]?.length ?? 0) + 1;
  }
  const point = pointAt(event);
  if (point === undefined || point.node.nodeType !== Node.TEXT_NODE) return start;
  const words = (point.node.textContent ?? "").slice(point.offset, point.offset + 12).trimEnd();
  if (words === "") return start;
  const found = source.indexOf(words, start);
  // Only within the next few lines, or a phrase that repeats would send the
  // caret to a later paragraph.
  const limit = start + lines.slice(line, line + 12).join("\n").length;
  return found === -1 || found > limit ? start : found;
}

/** Why Edit is not offered, said on the button. */
function notEditable(read: Readable): string {
  if (read.truncated) return "Only the first 2 MB were read; open it externally to edit it";
  return `Read as ${read.encoding}; open it externally to edit it`;
}

/** Said under a file that was not read whole, or not as plain UTF-8. */
function readNote(read: Readable): string {
  const parts: string[] = [];
  if (read.truncated) parts.push("Only the first 2 MB are shown.");
  if (read.encoding === "utf-8-bom")
    parts.push("UTF-8 with a byte-order mark, which a save keeps.");
  else if (read.encoding !== "utf-8") {
    parts.push(`Read as ${read.encoding}. Open it externally to edit it.`);
  }
  return parts.join(" ");
}
