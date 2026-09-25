import type {
  SidebarFolderRow,
  WireAssetDetail,
  WireFolderRef,
  WireSelectionSummary,
  WireSharedText,
} from "@roost/contract";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { FileProblem } from "../FileProblem.js";
import { bytes, counted } from "../format.js";
import type { ConfirmRequest } from "../grid/trash-actions.js";
import { Placeholder } from "../Placeholder.js";
import { fallbackToGrid, previewSrc, showLoaded } from "../thumbnail.js";
import { duration } from "../timecode.js";
import { Comments } from "./Comments.js";
import { FolderField } from "./FolderField.js";
import { type TagChoice, TagField } from "./TagField.js";

/**
 * Everything known about the selection, all of it editable.
 *
 * **The selection, not the focused asset.** Until 2026-08-30 this panel took one
 * id and every edit sent `[detail.id]`, so selecting five assets and adding
 * a tag tagged one of them — reported from real use, and invisible to any test
 * that only asked whether the tag arrived. The contract has taken `ids` as an
 * array since M2 and the engine has always written one journal batch for all of
 * them; the interface was the whole of the bug.
 *
 * One asset and several are **the same components** given different data, which
 * is what stops the bug coming back for one path and not the other: `Rating`,
 * the favourite button, and `TagEditor` all take a list of ids and never
 * learn how long it is.
 *
 * **Every edit reads the record back** rather than trusting what it sent. That
 * is not caution for its own sake: the engine trims a name, drops an
 * all-whitespace note, and deduplicates tags on the way through, so an
 * inspector that displayed what it had typed would show a state the library
 * does not hold — and the next reload would silently correct it.
 *
 * **The panel is always drawn** (`UI_SPEC.md` §3). It used to render nothing on
 * an empty selection, on the reasoning that a shell of disabled controls looks
 * broken rather than idle — which is true, and is answered by drawing an empty
 * *state* instead of disabled controls (§8). What the old behaviour cost was
 * measured in a real window on 2026-09-01: selecting one asset took the grid
 * from 1040px and four columns to 760px and two, and deselecting took it back,
 * so every cell moved twice for every click on the background.
 */

/** How long after the last keystroke a note saves itself. */
export const NOTE_IDLE_MS = 1000;

/** One asset has no partial tags, and a fresh `[]` per render is a new memo. */
const NO_TAGS: readonly string[] = [];

/** The same, for the folders one asset is in — it is in all of them. */
const NO_FOLDERS: readonly WireFolderRef[] = [];

export interface InspectorProps {
  /**
   * The selection, in result order. Empty when nothing is selected.
   *
   * The caller must keep this array's identity stable across unrelated renders
   * — it is what the read effect depends on, and a fresh array per render would
   * re-read the library on every keystroke elsewhere in the window.
   */
  readonly ids: readonly string[];
  /** Bumped by the caller when something outside the inspector changed. */
  readonly generation: number;
  /**
   * Every tag the library has, for the tag field to suggest from.
   *
   * The window already holds these for the navigation pane and re-reads them
   * whenever the library changes, so a tag added here is suggestible the moment
   * it exists. Empty is a valid answer — a library with no tags yet, or a
   * window whose first sidebar read has not landed.
   */
  readonly vocabulary: readonly TagChoice[];
  /**
   * Every folder in the library, for the folder control to offer.
   *
   * The same arrangement as `vocabulary` and for the same reason: the window
   * already holds these rows for the navigation pane and re-reads them whenever
   * the library changes, so a folder made in the sidebar is offerable here the
   * moment it exists, and nothing asks the engine twice for one small tree.
   */
  readonly folders: readonly SidebarFolderRow[];
  /**
   * An asset was renamed here, and the window holds a card that says otherwise.
   *
   * A rename moves neither the asset count nor the trash count, so the grid does
   * not re-page on one (`App.tsx`, on `revision`) and its cell kept the old name
   * until the view was left and come back to. Optional because the panel works
   * without a grid behind it, which is what every test of it renders.
   */
  readonly onRenamed?: (id: string, name: string) => void;
  /**
   * Show what this query selects, replacing what is on screen.
   *
   * The same callback a sidebar row is given and the same rule with it: the
   * query travels from the engine, through the row or the chip, to the window —
   * the panel assembles none of it (`UI_SPEC.md` §3.2).
   */
  readonly onPick: (query: string) => void;
  /**
   * Ask before a write that would replace what several assets hold (ADR-0048).
   *
   * The window's dialog rather than one of the panel's own, because the
   * question is raised on blur — usually by a click on another cell, which
   * changes the selection and can unmount the very panel that asked.
   * Optional, like `onRenamed`: without it nothing is asked and nothing mixed
   * is written.
   */
  readonly onConfirm?: (request: ConfirmRequest) => void;
}

export function Inspector({
  ids,
  generation,
  vocabulary,
  folders,
  onRenamed,
  onPick,
  onConfirm,
}: InspectorProps): React.JSX.Element | null {
  const [detail, setDetail] = useState<WireAssetDetail | undefined>();
  const [summary, setSummary] = useState<WireSelectionSummary | undefined>();

  /**
   * Which read is the current one.
   *
   * The selection can change faster than the engine answers — a marquee sweep
   * changes it on every frame it crosses a cell — and two reads in flight
   * resolve in whatever order they finish. Without this the panel can settle on
   * the summary of a selection the user has already dragged past.
   */
  const latest = useRef(0);

  const read = useCallback(async () => {
    const ticket = latest.current + 1;
    latest.current = ticket;
    const only = ids.length === 1 ? ids[0] : undefined;

    if (only !== undefined) {
      const outcome = await invoke({ type: "asset:detail", id: only });
      if (latest.current !== ticket) return;
      setSummary(undefined);
      // A selection can outlive the asset it points at; `null` is the answer to
      // that, and it empties the panel rather than raising anything.
      setDetail(outcome.ok && outcome.value !== null ? outcome.value : undefined);
      return;
    }

    setDetail(undefined);
    if (ids.length === 0) {
      setSummary(undefined);
      return;
    }

    // One request for the whole selection rather than a detail each: a
    // selection is routinely hundreds of rows, and what this draws is a summary
    // of them.
    const outcome = await invoke({ type: "asset:summary", ids });
    if (latest.current !== ticket) return;
    setSummary(outcome.ok ? outcome.value : undefined);
  }, [ids]);

  /*
   * `generation` is a trigger, not a value the body reads: something outside
   * the panel changed the library and what is on screen may no longer be true.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    void read();
  }, [read, generation]);

  if (ids.length === 0) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <div className="inspector-empty">
          <h2>Nothing selected</h2>
          <p>Pick an asset to see its tags, rating, note, and metadata.</p>
        </div>
      </aside>
    );
  }

  if (summary !== undefined) {
    return (
      <Selection
        ids={ids}
        summary={summary}
        vocabulary={vocabulary}
        folders={folders}
        onPick={onPick}
        onSaved={read}
        {...(onConfirm === undefined ? {} : { onConfirm })}
      />
    );
  }

  // Something is selected and its record has not arrived — still loading, or an
  // asset another window removed while this one still points at it. An empty
  // panel is the right answer to both, and it has to keep its width or the
  // reflow this component exists to avoid comes back on every selection.
  if (detail === undefined) return <aside className="inspector" aria-label="Inspector" />;

  return (
    <aside className="inspector" aria-label="Inspector">
      {/*
        The 512px thumbnail, generated on first use rather than at import
        (`ARCHITECTURE.md` §4.5) — so an asset nobody has looked at yet has none, and
        the placeholder shows through underneath exactly as it does in the grid.
        Bytes come over `roost://`, never through a message (invariant 12).
      */}
      <div className="inspector-preview">
        <Placeholder kind={detail.kind} ext={detail.ext} undrawn={detail.undrawn} />
        <img
          className="cell-image"
          src={previewSrc(detail.id, detail.posterMs, detail.derivedAt)}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={showLoaded}
          onError={fallbackToGrid}
        />
      </div>

      {/* Why this file has no picture and what to do, the moment it is selected
          (ADR-0050). Nothing at all for a file that has one. */}
      <FileProblem detail={detail} />

      <NameField detail={detail} onRenamed={onRenamed} onSaved={read} />

      <Rating value={detail.rating} mixed={false} ids={ids} onSaved={read} />

      <TagEditor
        ids={ids}
        shared={detail.tags}
        partial={NO_TAGS}
        vocabulary={vocabulary}
        onPick={onPick}
        onSaved={read}
      />
      <FolderEditor
        ids={ids}
        shared={detail.folders}
        partial={NO_FOLDERS}
        tree={folders}
        onPick={onPick}
        onSaved={read}
      />
      <NoteField ids={ids} held={single(detail.note)} trigger={detail} onSaved={read} />
      <SourceField ids={ids} held={single(detail.sourceUrl)} trigger={detail} onSaved={read} />
      {/* Keyed on the id so a half-typed comment does not follow the
          selection onto the next asset: the drafts here belong to the asset
          they were started on, and React would otherwise keep them across a
          change of `detail`. */}
      <Comments key={detail.id} detail={detail} onSaved={read} />
      <Subtitles detail={detail} onSaved={read} />
      <Metadata detail={detail} />

      <button
        type="button"
        onClick={() => void invoke({ type: "asset:openExternally", id: detail.id })}
      >
        Open externally
      </button>
    </aside>
  );
}

/**
 * The caption tracks attached to this asset (ADR-0025, `UI_SPEC.md` §3).
 *
 * Here rather than in the sidebar, which the user considered first: a sidebar
 * row is a **query**, and a query cannot mean "the tracks of whatever is
 * selected". This panel is the one place that is already about one asset.
 *
 * A track is an ordinary asset, so the three things worth doing to it are the
 * three a file has anywhere: open it in the editor that owns it, show it where
 * it lives, and delete it.
 *
 * **Delete detaches it and moves it to the trash**, in one batch. A "detach"
 * that left the `.srt` behind in the grid was tried first and was the wrong
 * half of the answer: somebody finished with a track is finished with the file.
 * `Delete` still means what it means everywhere else — the trash keeps the row,
 * nothing is emptied on a schedule, and restoring brings the file back (the
 * attachment does not come with it, because that was a second sentence and it
 * was un-said).
 *
 * The name takes a line of its own and the actions the line below it. Three
 * buttons beside a filename is a row that wraps at any width worth having, and
 * the panel is the narrowest surface in the window.
 */
function Subtitles({
  detail,
  onSaved,
}: {
  readonly detail: WireAssetDetail;
  readonly onSaved: () => void;
}): React.JSX.Element | null {
  if (detail.subtitles.length === 0) return null;

  return (
    <section className="subtitles" aria-label="Subtitles">
      <ul className="subtitle-list">
        {detail.subtitles.map((track) => (
          <li key={track.id} className="subtitle">
            <span className="subtitle-line">
              <span className="subtitle-name" title={track.name}>
                {track.label ?? track.name}
              </span>
              {track.lang !== null && <span className="subtitle-lang">{track.lang}</span>}
            </span>
            <span className="subtitle-actions">
              <button
                type="button"
                title="Open in the application that owns it"
                onClick={() => void invoke({ type: "asset:openExternally", id: track.id })}
              >
                Open
              </button>
              <button
                type="button"
                title="Show the file where it lives"
                onClick={() => void invoke({ type: "asset:reveal", id: track.id })}
              >
                Show in file manager
              </button>
              {/* No confirmation: `Delete` is the trash everywhere in Roost,
                  and the trash is reversible (ADR-0022). A dialog here would
                  teach people to dismiss dialogs, and the next one is the
                  permanent delete. */}
              <button
                type="button"
                title="Detach it and move the file to the trash"
                onClick={() => {
                  void (async () => {
                    await invoke({
                      type: "asset:subtitleDelete",
                      id: detail.id,
                      track: track.id,
                    });
                    onSaved();
                  })();
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The extension the name ends with, as the name spells it — or `""`.
 *
 * Taken from the name rather than from `detail.ext` so that its *case* is the
 * one on screen: the column is lowercased at import (`import.ts`) and a file
 * called `Holiday.JPG` would otherwise come back shouting.
 *
 * `""` when the name does not end in the extension at all, which is a name some
 * earlier rename left disagreeing with the file. There is nothing to hide then,
 * and nothing is appended on the way out either — the name is shown whole and
 * saved as typed.
 */
function extensionOf(detail: WireAssetDetail): string {
  if (detail.ext === "") return "";
  const suffix = `.${detail.ext}`;
  const tail = detail.name.slice(-suffix.length);
  return tail.toLowerCase() === suffix ? tail : "";
}

/**
 * The display name, and the panel's heading (`UI_SPEC.md` §3.10). The file on
 * disk keeps its id filename (invariant 3).
 *
 * **The extension is not in the field.** `ext` is decided once, at import, from
 * the file that arrived, and `asset_rename` has never touched it — so typing
 * over `.txt` here renamed nothing: the column, the file under `files/`,
 * the kind the grid draws and everything that reads them all went on saying
 * `txt`, and the panel was the only place in the application that claimed
 * otherwise. A field that cannot change a thing should not offer to. The
 * extension is still on screen twice, as the placeholder's badge and as
 * **Kind** — what is gone is the invitation to edit it.
 *
 * **It wraps, and it grows to fit.** A generated filename is routinely longer
 * than a 280px column, and a single-line field answers that by scrolling
 * sideways: the name is then something to be operated before it can be read,
 * and the panel's heading no longer says which asset is selected. So the whole
 * of it is shown, over as many lines as it takes.
 *
 * A `textarea` is the only control that wraps, but a name has no lines — so
 * `Enter` commits as it did before rather than making a second one, and a
 * pasted newline becomes a space on the way in. Nothing that reaches the engine
 * has ever contained one, and this is where that stays true: `cleanName` trims
 * the ends and would carry an interior newline straight into the journal.
 *
 * The height is set from the content because a `textarea` will not size itself
 * to what it holds — reset to nothing first, or the box only ever grows.
 */
function NameField({
  detail,
  onRenamed,
  onSaved,
}: {
  readonly detail: WireAssetDetail;
  readonly onRenamed: ((id: string, name: string) => void) | undefined;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const extension = extensionOf(detail);
  const stem = detail.name.slice(0, detail.name.length - extension.length);
  const [draft, setDraft] = useState(stem);
  const saved = useRef(stem);
  useStoredValue(detail, stem, saved, setDraft);
  const field = useRef<HTMLTextAreaElement>(null);

  // Before paint: a box that is briefly one line high and then jumps is the
  // panel's whole heading moving under the reader.
  //
  // `draft` is the trigger and nothing here reads it — what is being measured is
  // the box the browser laid out for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useLayoutEffect(() => {
    const node = field.current;
    // happy-dom lays nothing out, so every measurement here is zero and the
    // height would be pinned to it. A window has layout; the tests assert the
    // value, not the size.
    if (node === null || node.scrollHeight === 0) return;
    node.style.height = "auto";
    // `scrollHeight` is the padding box and the box is `border-box`, so the
    // borders have to be added back or every name loses two pixels.
    node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
  }, [draft]);

  const save = (): void => {
    // Trimmed here rather than left to `cleanName`, which trims the whole name:
    // with the extension put back on, a trailing space would be in the middle
    // and would survive, and the field would then show one the reader did not
    // type.
    const name = `${draft.trim()}${extension}`;
    if (draft.trim() === "" || name === detail.name) {
      setDraft(stem);
      return;
    }
    // The draft, not the trimmed name: the re-read then disagrees with what was
    // sent and `useStoredValue` adopts what the library actually stored, which
    // is how a typed trailing space disappears from the field.
    saved.current = draft;
    void invoke({ type: "asset:rename", id: detail.id, name }).then((outcome) => {
      // The name that was sent, and `cleanName` only trims — which this has
      // already done. Told after the engine confirms, never before: a cell
      // showing a name the write then refused is worse than a stale one.
      if (outcome.ok) onRenamed?.(detail.id, name);
      return onSaved();
    });
  };

  return (
    <textarea
      ref={field}
      className="inspector-name"
      aria-label="Name"
      spellCheck={false}
      rows={1}
      value={draft}
      onChange={(changed) => setDraft(changed.target.value.replace(/[\r\n]+/g, " "))}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") setDraft(stem);
      }}
    />
  );
}

/**
 * One to five, and clearable.
 *
 * `null` is unrated and is **not** zero (`DATA_MODEL.md`): clicking the star
 * that is already the rating clears it, which is the only gesture that can
 * express the difference without a second control.
 *
 * Five toggle buttons rather than a radio group, and the clearing is why. A
 * radio cannot be unchecked by clicking it, so calling these radios would
 * promise a keyboard behaviour they deliberately do not have.
 */
function Rating({
  value,
  mixed,
  ids,
  onSaved,
}: {
  readonly value: number | null;
  /** The selection disagrees. Distinct from `null`, which is "none is rated". */
  readonly mixed: boolean;
  readonly ids: readonly string[];
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  return (
    <div className="rating" data-mixed={mixed || undefined}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          aria-pressed={value !== null && star <= value}
          aria-label={`${star} star${star === 1 ? "" : "s"}`}
          data-on={value !== null && star <= value ? "" : undefined}
          onClick={() => {
            // Clicking the rating they already share clears it, which is the
            // only gesture that can express unrated without a second control.
            // A mixed selection has no shared rating to clear, so a click
            // always sets.
            void invoke({
              type: "asset:rate",
              ids,
              rating: !mixed && value === star ? null : star,
            }).then(onSaved);
          }}
        >
          ★
        </button>
      ))}
      {mixed && <span className="mixed">mixed</span>}
    </div>
  );
}

/**
 * Tags, added on Enter and removed by their own button.
 *
 * **Shared and partial tags are drawn apart** (`UI_SPEC.md` §3.2). A tag two of
 * three assets carry is not the same claim as one all three carry, and a panel
 * that showed them alike would be lying about the selection. Partial tags are
 * dimmed and labelled with how many carry them.
 *
 * Adding applies to everything selected. Removing a partial tag is the same
 * call — the engine ignores an asset that does not carry it — so there is no
 * second gesture to learn.
 */
function TagEditor({
  ids,
  shared,
  partial,
  vocabulary,
  onPick,
  onSaved,
}: {
  readonly ids: readonly string[];
  readonly shared: readonly string[];
  readonly partial: readonly string[];
  readonly vocabulary: readonly TagChoice[];
  readonly onPick: (query: string) => void;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  // Both halves, because a suggestion is a no-op for either: the engine ignores
  // an asset that already carries the tag, and offering one would say otherwise.
  const attached = useMemo(() => [...shared, ...partial], [shared, partial]);

  /**
   * The query each tag carries, by name.
   *
   * The vocabulary is the sidebar's, and a sidebar row arrives with the RQL
   * that selects it — so filtering by a chip asks for exactly what clicking the
   * tag in the navigation pane asks for, down to the quoting. Case-folded on
   * the way in because the two lists come from different statements: the
   * summary says what the selection carries and the sidebar says what the
   * library has, and tag names are case-insensitive as the schema stores them.
   */
  const queries = useMemo(
    () => new Map(vocabulary.map((choice) => [choice.name.toLowerCase(), choice.query])),
    [vocabulary],
  );

  const add = (tag: string): void => {
    void invoke({ type: "asset:tagAdd", ids, tags: [tag] }).then(onSaved);
  };

  const remove = (tag: string): void => {
    void invoke({ type: "asset:tagRemove", ids, tags: [tag] }).then(onSaved);
  };

  /**
   * One chip. **The name is a button, and clicking it filters by the tag** —
   * the gesture the folder chip beside it already had. It was a right-click
   * menu first (2026-09-07), holding *Filter by this tag* and *Remove tag*;
   * the user asked on 2026-09-24 for the filter to be one click, and with it
   * on the name the menu had nothing left to offer that the `×` does not.
   *
   * Disabled when the vocabulary does not know the tag — which is the moment
   * after one is added, before the window has re-read the sidebar. Assembling
   * the missing query here would be the renderer spelling the grammar
   * (`Sidebar`'s own rule).
   */
  const chip = (tag: string, only: boolean): React.JSX.Element => {
    const query = queries.get(tag.toLowerCase());
    return (
      <li key={tag} className="tag" {...(only ? { "data-partial": "" } : {})}>
        <button
          type="button"
          className="tag-name"
          disabled={query === undefined}
          title={
            only
              ? `Only some of the ${ids.length} selected assets carry this`
              : `Show everything tagged ${tag}`
          }
          onClick={() => {
            if (query !== undefined) onPick(query);
          }}
        >
          {tag}
        </button>
        <button
          type="button"
          className="chip-remove"
          aria-label={`Remove ${tag}`}
          onClick={() => remove(tag)}
        >
          ×
        </button>
      </li>
    );
  };

  return (
    <div className="tags">
      <ul className="tag-list">
        {shared.map((tag) => chip(tag, false))}
        {partial.map((tag) => chip(tag, true))}
      </ul>
      <TagField vocabulary={vocabulary} attached={attached} onAdd={add} />
    </div>
  );
}

/**
 * The folders the selection is in, and a menu to add another (`UI_SPEC.md` §3.9).
 *
 * **The same component for one asset and for twelve**, exactly as `TagEditor`
 * is, and for the reason §3.2 records: the panel edits the selection, and a
 * second code path for the single-asset case is how it came to edit one asset
 * out of five the last time these two were different components.
 *
 * A folder some of the selection is in is drawn apart from one all of it is in.
 * Removing either is the same call — the engine ignores an asset that is not in
 * the folder — so the distinction is a thing said, not a thing branched on.
 *
 * **Detaching is not deleting.** Taking an asset out of a folder leaves the
 * asset alone: folders are collections, not locations (RL-38), and
 * nothing on disk moves. That is why there is no confirmation here and why the
 * button is an `×` like a tag's rather than a word like `Delete`.
 */
function FolderEditor({
  ids,
  shared,
  partial,
  tree,
  onPick,
  onSaved,
}: {
  readonly ids: readonly string[];
  readonly shared: readonly WireFolderRef[];
  readonly partial: readonly WireFolderRef[];
  readonly tree: readonly SidebarFolderRow[];
  readonly onPick: (query: string) => void;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const attached = useMemo(
    () => [...shared, ...partial].map((folder) => folder.id),
    [shared, partial],
  );

  // By id rather than by path: two folders may share a name, the path is what
  // is drawn, and the id is the only thing both lists agree on.
  const queries = useMemo(() => new Map(tree.map((row) => [row.folder, row.query])), [tree]);

  const add = (folder: number): void => {
    void invoke({ type: "asset:folderAdd", ids, folder }).then(onSaved);
  };

  const remove = (folder: number): void => {
    void invoke({ type: "asset:folderRemove", ids, folder }).then(onSaved);
  };

  /**
   * One chip. **The name is a button, and clicking it shows the folder** —
   * asked for on 2026-09-07. A folder chip says one thing, so there is nothing
   * to choose between and a menu would be a click in the way. The tag chip
   * took the same gesture on 2026-09-24.
   *
   * It is a plain button when the tree has not arrived — the panel and the
   * navigation pane read the library separately, and a chip that navigated
   * nowhere would be worse than one that plainly does not.
   */
  const chip = (folder: WireFolderRef, only: boolean): React.JSX.Element => {
    const query = queries.get(folder.id);
    return (
      <li key={folder.id} className="folder" {...(only ? { "data-partial": "" } : {})}>
        <button
          type="button"
          className="folder-name"
          disabled={query === undefined}
          title={
            only
              ? `Only some of the ${ids.length} selected assets are in ${folder.path}`
              : folder.path
          }
          onClick={() => {
            if (query !== undefined) onPick(query);
          }}
        >
          {folder.path}
        </button>
        <button
          type="button"
          className="chip-remove"
          aria-label={`Remove from ${folder.path}`}
          onClick={() => remove(folder.id)}
        >
          ×
        </button>
      </li>
    );
  };

  return (
    <div className="folders">
      <ul className="folder-list">
        {shared.map((folder) => chip(folder, false))}
        {partial.map((folder) => chip(folder, true))}
      </ul>
      <FolderField tree={tree} attached={attached} onAdd={add} />
    </div>
  );
}

/**
 * The panel for a selection of several assets (`UI_SPEC.md` §3.2).
 *
 * What is missing here is the point. There is **no name field**, because a name
 * is unique to one asset; **no note**, because a note is a paragraph about one
 * thing and writing one across twelve assets would silently destroy eleven; and
 * **no preview**, because showing one asset's picture over controls that edit
 * all of them is the misreading this whole change exists to correct.
 */
function Selection({
  ids,
  summary,
  vocabulary,
  folders,
  onPick,
  onSaved,
  onConfirm,
}: {
  readonly ids: readonly string[];
  readonly summary: WireSelectionSummary;
  readonly vocabulary: readonly TagChoice[];
  readonly folders: readonly SidebarFolderRow[];
  readonly onPick: (query: string) => void;
  readonly onSaved: () => Promise<void>;
  readonly onConfirm?: (request: ConfirmRequest) => void;
}): React.JSX.Element {
  return (
    <aside className="inspector" aria-label="Inspector">
      <h2 className="inspector-count">{counted(summary.count)} assets</h2>

      <Rating value={summary.rating} mixed={summary.ratingMixed} ids={ids} onSaved={onSaved} />

      <TagEditor
        ids={ids}
        shared={summary.sharedTags}
        partial={summary.partialTags}
        vocabulary={vocabulary}
        onPick={onPick}
        onSaved={onSaved}
      />

      <FolderEditor
        ids={ids}
        shared={summary.sharedFolders}
        partial={summary.partialFolders}
        tree={folders}
        onPick={onPick}
        onSaved={onSaved}
      />

      <NoteField
        ids={ids}
        held={summary.note}
        trigger={summary}
        onSaved={onSaved}
        {...(onConfirm === undefined ? {} : { onConfirm })}
      />
      <SourceField
        ids={ids}
        held={summary.source}
        trigger={summary}
        onSaved={onSaved}
        {...(onConfirm === undefined ? {} : { onConfirm })}
      />

      <dl className="metadata">
        <div className="metadata-row">
          <dt>Size</dt>
          <dd>{bytes(summary.totalBytes)}</dd>
        </div>
        {summary.kinds.length > 0 && (
          <div className="metadata-row">
            <dt>Kinds</dt>
            <dd>
              {summary.kinds
                .map((kind) => (kind === "" ? "unknown" : kind.toUpperCase()))
                .join(", ")}
            </dd>
          </div>
        )}
      </dl>
    </aside>
  );
}

/** One asset's value of a free-text field, in the shape a selection's takes. */
function single(value: string | null): WireSharedText {
  return { value, mixed: false, distinct: value === null ? 0 : 1, holding: value === null ? 0 : 1 };
}

/** What a free-text field needs to know to write across a selection (ADR-0048). */
interface TextFieldProps {
  readonly ids: readonly string[];
  /** What the selection holds, together — one asset's is {@link single}. */
  readonly held: WireSharedText;
  /**
   * Whatever the panel re-read, as the signal that it did: a fresh object per
   * read. See {@link useStoredValue}.
   */
  readonly trigger: object;
  readonly onSaved: () => Promise<void>;
  readonly onConfirm?: (request: ConfirmRequest) => void;
}

/**
 * A free-text field's draft, and the one way it is written (ADR-0048).
 *
 * **One asset and twelve are the same code**, as the rating and the tags are
 * (`UI_SPEC.md` §3.2): the single-asset panel passes a list of one, whose
 * field can never be mixed. Where the selection agrees — the same value, or
 * none at all — the field shows it and a write replaces what is on screen.
 * Where it disagrees the field starts empty, and a write that would replace
 * something asks first; cancelling puts the field back to empty.
 *
 * A mixed field is written on blur alone, never on the idle timer: the timer is
 * there so a note survives a crash mid-paragraph, and here it would raise a
 * dialog in the middle of one.
 */
function useTextField(
  { ids, held, trigger, onSaved, onConfirm }: TextFieldProps,
  noun: string,
  send: (ids: readonly string[], value: string | null) => Promise<unknown>,
): {
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly save: () => void;
  readonly placeholder: string | undefined;
} {
  const stored = held.value ?? "";
  const [draft, setDraft] = useState(stored);
  const saved = useRef(stored);
  useStoredValue(trigger, stored, saved, setDraft);

  const save = useCallback((): void => {
    if (draft === saved.current) return;
    const text = draft;
    const write = (): void => {
      saved.current = text;
      void send(ids, text.trim() === "" ? null : text).then(onSaved);
    };
    if (!held.mixed || held.holding === 0) {
      write();
      return;
    }
    // Never written without the question: a panel with no way to ask writes
    // nothing mixed at all.
    onConfirm?.({
      title: `Replace the ${noun}s?`,
      body:
        `Replace the ${noun} on ${counted(ids.length)} assets? ` +
        `${counted(held.holding)} of them already have one.`,
      confirmLabel: "Replace",
      run: write,
      onCancel: () => setDraft(saved.current),
    });
  }, [draft, ids, held, noun, send, onSaved, onConfirm]);

  useEffect(() => {
    if (held.mixed) return;
    const timer = setTimeout(save, NOTE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [save, held.mixed]);

  // Says how it disagrees, so an empty field is not read as "none of them has
  // one": several different values, or one value some of them lack.
  const placeholder = !held.mixed
    ? undefined
    : held.distinct > 1
      ? `Mixed — ${counted(held.distinct)} different ${noun}s`
      : `Mixed — ${counted(held.holding)} of ${counted(ids.length)} have a ${noun}`;

  return { draft, setDraft, save, placeholder };
}

const sendNote = (ids: readonly string[], note: string | null) =>
  invoke({ type: "asset:note", ids, note });

const sendSource = (ids: readonly string[], url: string | null) =>
  invoke({ type: "asset:source", ids, url });

/** Autosaves on blur and after a second's idle (`UI_SPEC.md` §3). */
function NoteField(props: TextFieldProps): React.JSX.Element {
  const { draft, setDraft, save, placeholder } = useTextField(props, "note", sendNote);

  return (
    <textarea
      className="note"
      aria-label="Note"
      placeholder={placeholder ?? "Note"}
      rows={3}
      value={draft}
      onChange={(changed) => setDraft(changed.target.value)}
      onBlur={save}
    />
  );
}

/**
 * Where the file came from (ADR-0030).
 *
 * The note's field with one line instead of three and one addition: when the
 * value is an `http(s)` address, a button beside it opens the desktop's
 * browser. Nothing is fetched — invariant 7 stands — and nothing opens without
 * that click: no preview, no favicon, no title lookup, each of which would
 * arrive looking like a small convenience.
 *
 * **The affordance is absent rather than disabled for anything else.** A bare
 * `instagram.com/p/xyz` or a `file:///archive/` is a perfectly good answer to
 * "where did this come from" and is stored as typed (ADR-0030 §2), but it is
 * not something to hand the desktop's URL handler on a click. A control that
 * cannot be operated is worse than an absent one (`UI_SPEC.md` §8).
 *
 * A single line, not a textarea: this has one value and no paragraphs, and
 * `Enter` therefore saves rather than making a second line.
 */
function SourceField(props: TextFieldProps): React.JSX.Element {
  const { draft, setDraft, save, placeholder } = useTextField(props, "source", sendSource);

  // What the *engine* holds, not what is being typed: an address half-entered
  // is not one to offer, and the button would flicker in and out on the way to
  // `https://`. A mixed selection holds no one value to open.
  const url = props.held.value;
  const openable = url !== null && /^https?:\/\/\S+$/.test(url);

  return (
    <div className="source">
      <input
        type="text"
        className="source-field"
        aria-label="Source"
        placeholder={placeholder ?? "Source — where this came from"}
        spellCheck={false}
        value={draft}
        onChange={(changed) => setDraft(changed.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          // One value and no paragraphs, so Enter is the save the blur would
          // have done.
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          }
        }}
      />
      {openable && (
        <button
          type="button"
          className="source-open"
          aria-label="Open source in browser"
          title={url}
          onClick={() => void invoke({ type: "link:open", url })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M6.5 3.5H3.5v9h9v-3M9.5 2.5h4v4M13 3l-6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Adopts what the engine stored, whenever that differs from what was sent.
 *
 * The subtle half of "every edit reads the record back". Watching the *value*
 * is not enough: a note of three spaces is stored as `null`, and if it was
 * already `null` the field would go on showing three spaces that the library
 * does not hold — visible only after a reload, which is the worst place to
 * find it. So the re-read itself is the trigger, and `sent` is what decides
 * whether anything changed.
 *
 * It also decides what does *not* happen: an unrelated edit elsewhere re-reads
 * this asset too, and `stored === sent.current` is what stops that from
 * stomping a half-typed draft.
 */
function useStoredValue(
  trigger: object,
  stored: string,
  sent: React.RefObject<string>,
  adopt: (value: string) => void,
): void {
  /*
   * `trigger` is the trigger — a fresh object per re-read — and everything the
   * body reads comes from it or from a ref.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (stored === sent.current) return;
    sent.current = stored;
    adopt(stored);
  }, [trigger]);
}

/** What the library knows and nobody can edit. */
function Metadata({ detail }: { readonly detail: WireAssetDetail }): React.JSX.Element {
  const rows: readonly (readonly [string, string])[] = [
    ["Kind", detail.ext === "" ? "unknown" : detail.ext.toUpperCase()],
    // Every derived field reads "not read yet" rather than a zero: in version
    // 2 a size is a fact about bytes nothing has looked at until something has
    // (RL-22), and "0 bytes" would be a measurement nobody took.
    ["Size", detail.size === null ? "not read yet" : bytes(detail.size)],
    // A font's stored size is its specimen sheet's, kept so the grid can lay the
    // cell out. It is not a fact about the typeface, so it is not shown here.
    ...(detail.width === null || detail.height === null || detail.kind === "font"
      ? []
      : ([["Dimensions", `${detail.width} × ${detail.height}`]] as const)),
    ...(detail.durationMs === null ? [] : ([["Duration", duration(detail.durationMs)]] as const)),
    ...(detail.pageCount === null ? [] : ([["Pages", counted(detail.pageCount)]] as const)),
    // Whatever the format's own backend reported. The order is the vocabulary's
    // rather than the map's, so a font always reads family-then-style and two
    // assets of the same kind line up.
    ...propertyRows(detail.props),

    ["Imported", when(detail.importedAt)],
    ...(detail.createdAt === null ? [] : ([["Created", when(detail.createdAt)]] as const)),
    // The id last, and in full: it is the asset's identity (invariant 1) and
    // the thing a bug report needs, but it is not what anyone reads first.
    ["Id", detail.id],
  ];

  return (
    <dl className="metadata">
      {rows.map(([label, value]) => (
        <div key={label} className="metadata-row">
          <dt>{label}</dt>
          <dd title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The derived properties worth showing, in a fixed order with readable labels.
 *
 * A key the renderer has no label for is shown under its own name rather than
 * hidden: a backend that starts reporting something new should be visible in
 * the inspector before anyone writes a line of interface code for it.
 */
const PROPERTY_LABELS: readonly (readonly [string, string])[] = [
  ["font.family", "Family"],
  ["font.style", "Style"],
  ["font.glyphs", "Glyphs"],
  // Both are qualified, not just the audio one. A file carrying video and
  // audio showed two rows both labelled "Codec", and leaving the video row
  // bare would only have moved the ambiguity to the file that has one track.
  ["video.codec", "Video codec"],
  ["video.fps", "Frame rate"],
  ["audio.codec", "Audio codec"],
  ["audio.channels", "Channels"],
  ["audio.sampleRate", "Sample rate"],
];

function propertyRows(props: Readonly<Record<string, string>>): (readonly [string, string])[] {
  const known = PROPERTY_LABELS.filter(([key]) => props[key] !== undefined).map(
    ([key, label]) => [label, props[key] ?? ""] as const,
  );
  const rest = Object.entries(props)
    .filter(([key]) => !PROPERTY_LABELS.some(([known]) => known === key))
    .map(([key, value]) => [key, value] as const);
  return [...known, ...rest];
}

/**
 * A unix timestamp as the viewer's own locale renders it.
 *
 * Stored in UTC and shown in local time, because a timestamp is only useful
 * against the clock the person reading it lives by.
 */
function when(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}
