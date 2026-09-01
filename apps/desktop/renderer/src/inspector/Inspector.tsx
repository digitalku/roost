import type { WireAssetDetail, WireSelectionSummary } from "@roost/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { fallbackToGrid, previewSrc } from "../thumbnail.js";

/**
 * Everything known about the selection, all of it editable.
 *
 * **The selection, not the focused asset.** Until 2026-08-30 this panel took one
 * hash and every edit sent `[detail.hash]`, so selecting five assets and adding
 * a tag tagged one of them — reported from real use, and invisible to any test
 * that only asked whether the tag arrived. The contract has taken `hashes` as an
 * array since M2 and the engine has always written one journal batch for all of
 * them; the interface was the whole of the bug.
 *
 * One asset and several are **the same components** given different data, which
 * is what stops the bug coming back for one path and not the other: `Rating`,
 * the favourite button, and `TagEditor` all take a list of hashes and never
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

export interface InspectorProps {
  /**
   * The selection, in result order. Empty when nothing is selected.
   *
   * The caller must keep this array's identity stable across unrelated renders
   * — it is what the read effect depends on, and a fresh array per render would
   * re-read the library on every keystroke elsewhere in the window.
   */
  readonly hashes: readonly string[];
  /** Bumped by the caller when something outside the inspector changed. */
  readonly generation: number;
}

export function Inspector({ hashes, generation }: InspectorProps): React.JSX.Element | null {
  const [detail, setDetail] = useState<WireAssetDetail | undefined>();
  const [summary, setSummary] = useState<WireSelectionSummary | undefined>();

  const read = useCallback(async () => {
    const only = hashes.length === 1 ? hashes[0] : undefined;

    if (only !== undefined) {
      const outcome = await invoke({ type: "asset:detail", hash: only });
      setSummary(undefined);
      // A selection can outlive the asset it points at; `null` is the answer to
      // that, and it empties the panel rather than raising anything.
      setDetail(outcome.ok && outcome.value !== null ? outcome.value : undefined);
      return;
    }

    setDetail(undefined);
    if (hashes.length === 0) {
      setSummary(undefined);
      return;
    }

    // One request for the whole selection rather than a detail each: a
    // selection is routinely hundreds of rows, and what this draws is a summary
    // of them.
    const outcome = await invoke({ type: "asset:summary", hashes });
    setSummary(outcome.ok ? outcome.value : undefined);
  }, [hashes]);

  /*
   * `generation` is a trigger, not a value the body reads: something outside
   * the panel changed the library and what is on screen may no longer be true.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    void read();
  }, [read, generation]);

  if (hashes.length === 0) {
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
    return <Selection hashes={hashes} summary={summary} onSaved={read} />;
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
        (`STORAGE_SPEC.md`) — so an asset nobody has looked at yet has none, and
        the extension shows through underneath exactly as it does in the grid.
        Bytes come over `roost://`, never through a message (invariant 12).
      */}
      <div className="inspector-preview">
        <span className="cell-kind">{detail.ext === "" ? "file" : detail.ext}</span>
        <img
          className="cell-image"
          src={previewSrc(detail.hash)}
          alt=""
          decoding="async"
          draggable={false}
          onError={fallbackToGrid}
        />
      </div>

      <Name detail={detail} onSaved={read} />

      <div className="inspector-row">
        <Rating value={detail.rating} mixed={false} hashes={hashes} onSaved={read} />
        <Favorite state={detail.isFavorite ? "all" : "none"} hashes={hashes} onSaved={read} />
      </div>

      <TagEditor hashes={hashes} shared={detail.tags} partial={[]} onSaved={read} />
      <NoteField detail={detail} onSaved={read} />
      <Metadata detail={detail} />

      <button
        type="button"
        onClick={() => void invoke({ type: "asset:openExternally", hash: detail.hash })}
      >
        Open externally
      </button>
    </aside>
  );
}

/** The display name. The file on disk keeps its hash filename (invariant 3). */
function Name({
  detail,
  onSaved,
}: {
  readonly detail: WireAssetDetail;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(detail.name);
  const saved = useRef(detail.name);
  useStoredValue(detail, detail.name, saved, setDraft);

  const save = (): void => {
    if (draft.trim() === "" || draft === detail.name) {
      setDraft(detail.name);
      return;
    }
    saved.current = draft;
    void invoke({ type: "asset:rename", hash: detail.hash, name: draft }).then(onSaved);
  };

  return (
    <input
      className="inspector-name"
      aria-label="Name"
      spellCheck={false}
      value={draft}
      onChange={(changed) => setDraft(changed.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(detail.name);
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
  hashes,
  onSaved,
}: {
  readonly value: number | null;
  /** The selection disagrees. Distinct from `null`, which is "none is rated". */
  readonly mixed: boolean;
  readonly hashes: readonly string[];
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
              hashes,
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
 * The favourite toggle, over one asset or many.
 *
 * A mixed selection favourites everything rather than clearing: the gesture
 * people expect from a half-filled control is "make them all this", and the
 * destructive reading is the one that needs an explicit state to reach.
 */
function Favorite({
  state,
  hashes,
  onSaved,
}: {
  readonly state: "all" | "none" | "mixed";
  readonly hashes: readonly string[];
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="favorite"
      aria-pressed={state === "all"}
      aria-label="Favorite"
      data-mixed={state === "mixed" || undefined}
      onClick={() => {
        void invoke({ type: "asset:favorite", hashes, favorite: state !== "all" }).then(onSaved);
      }}
    >
      {state === "all" ? "★" : "☆"}
    </button>
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
  hashes,
  shared,
  partial,
  onSaved,
}: {
  readonly hashes: readonly string[];
  readonly shared: readonly string[];
  readonly partial: readonly string[];
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");

  const remove = (tag: string): void => {
    void invoke({ type: "asset:tagRemove", hashes, tags: [tag] }).then(onSaved);
  };

  return (
    <div className="tags">
      <ul className="tag-list">
        {shared.map((tag) => (
          <li key={tag} className="tag">
            <span>{tag}</span>
            <button type="button" aria-label={`Remove ${tag}`} onClick={() => remove(tag)}>
              ×
            </button>
          </li>
        ))}
        {partial.map((tag) => (
          <li key={tag} className="tag" data-partial>
            <span title={`Only some of the ${hashes.length} selected assets carry this`}>
              {tag}
            </span>
            <button type="button" aria-label={`Remove ${tag}`} onClick={() => remove(tag)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <input
        className="tag-input"
        aria-label="Add a tag"
        placeholder="Add a tag"
        spellCheck={false}
        value={draft}
        onChange={(changed) => setDraft(changed.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || draft.trim() === "") return;
          event.preventDefault();
          const tag = draft;
          setDraft("");
          void invoke({ type: "asset:tagAdd", hashes, tags: [tag] }).then(onSaved);
        }}
      />
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
  hashes,
  summary,
  onSaved,
}: {
  readonly hashes: readonly string[];
  readonly summary: WireSelectionSummary;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  return (
    <aside className="inspector" aria-label="Inspector">
      <h2 className="inspector-count">{summary.count.toLocaleString()} assets</h2>

      <div className="inspector-row">
        <Rating
          value={summary.rating}
          mixed={summary.ratingMixed}
          hashes={hashes}
          onSaved={onSaved}
        />
        <Favorite state={summary.favorite} hashes={hashes} onSaved={onSaved} />
      </div>

      <TagEditor
        hashes={hashes}
        shared={summary.sharedTags}
        partial={summary.partialTags}
        onSaved={onSaved}
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

/** Autosaves on blur and after a second's idle (`UI_SPEC.md` §3). */
function NoteField({
  detail,
  onSaved,
}: {
  readonly detail: WireAssetDetail;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(detail.note ?? "");
  const saved = useRef(detail.note ?? "");
  useStoredValue(detail, detail.note ?? "", saved, setDraft);

  const save = useCallback((): void => {
    if (draft === saved.current) return;
    saved.current = draft;
    void invoke({
      type: "asset:note",
      hash: detail.hash,
      note: draft.trim() === "" ? null : draft,
    }).then(onSaved);
  }, [draft, detail.hash, onSaved]);

  useEffect(() => {
    const timer = setTimeout(save, NOTE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [save]);

  return (
    <textarea
      className="note"
      aria-label="Note"
      placeholder="Note"
      rows={3}
      value={draft}
      onChange={(changed) => setDraft(changed.target.value)}
      onBlur={save}
    />
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
  detail: WireAssetDetail,
  stored: string,
  sent: React.RefObject<string>,
  adopt: (value: string) => void,
): void {
  /*
   * `detail` is the trigger — a fresh object per re-read — and everything the
   * body reads comes from it or from a ref.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (stored === sent.current) return;
    sent.current = stored;
    adopt(stored);
  }, [detail]);
}

/** What the library knows and nobody can edit. */
function Metadata({ detail }: { readonly detail: WireAssetDetail }): React.JSX.Element {
  const rows: readonly (readonly [string, string])[] = [
    ["Kind", detail.ext === "" ? "unknown" : detail.ext.toUpperCase()],
    ["Size", bytes(detail.size)],
    // A font's stored size is its specimen sheet's, kept so the grid can lay the
    // cell out. It is not a fact about the typeface, so it is not shown here.
    ...(detail.width === null || detail.height === null || detail.kind === "font"
      ? []
      : ([["Dimensions", `${detail.width} × ${detail.height}`]] as const)),
    ...(detail.durationMs === null ? [] : ([["Duration", duration(detail.durationMs)]] as const)),
    ...(detail.pageCount === null ? [] : ([["Pages", detail.pageCount.toLocaleString()]] as const)),
    // Whatever the format's own backend reported. The order is the vocabulary's
    // rather than the map's, so a font always reads family-then-style and two
    // assets of the same kind line up.
    ...propertyRows(detail.props),
    ["Storage", detail.storageMode],
    ...(detail.refPath === null ? [] : ([["Path", detail.refPath]] as const)),
    ["Imported", when(detail.importedAt)],
    ...(detail.createdAt === null ? [] : ([["Created", when(detail.createdAt)]] as const)),
    ...(detail.folders.length === 0 ? [] : ([["Folders", detail.folders.join(", ")]] as const)),
    // The hash last, and in full: it is the asset's identity (invariant 1) and
    // the thing a bug report needs, but it is not what anyone reads first.
    ["Hash", detail.hash],
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
  ["video.codec", "Codec"],
  ["video.fps", "Frame rate"],
  ["audio.codec", "Codec"],
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
 * `3:07`, or `1:02:07` for something long enough to need hours.
 *
 * Rounded to the second: a duration in milliseconds is what the schema stores
 * and not what anyone reads.
 */
function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Binary multiples, the way `STORAGE_SPEC.md` and the CLI both count. */
function bytes(size: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
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
