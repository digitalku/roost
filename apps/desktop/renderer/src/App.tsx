import type {
  LibraryStats,
  LibrarySummary,
  WireProblem,
  WireRecentLibrary,
  WireSidebar,
} from "@roost/contract";
import { LIBRARY_SUFFIX } from "@roost/contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { markFirstPaint } from "./bench/bench.js";
import { invoke, onEvent } from "./bridge.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DeriveStatus, useDeriveStatus } from "./DeriveStatus.js";
import { AssetContextMenu, DEFAULT_TEXT_NAME } from "./grid/AssetContextMenu.js";
import { Grid } from "./grid/Grid.js";
import { DEFAULT_ZOOM, GRID_VIEWS, type GridView, zoomBy } from "./grid/layout.js";
import { useAssetPages } from "./grid/paging.js";
import { SelectionStore } from "./grid/selection.js";
import { type ConfirmRequest, useTrashActions } from "./grid/trash-actions.js";
import { ViewMenu } from "./grid/ViewMenu.js";
import { DropZone } from "./import/DropZone.js";
import { type Importing, useImport } from "./import/useImport.js";
import { Inspector } from "./inspector/Inspector.js";
import { RecentList } from "./library/RecentList.js";
import { DraftEditor } from "./preview/DraftEditor.js";
import { PreviewPane } from "./preview/PreviewPane.js";
import { SearchField } from "./search/SearchField.js";
import { Sidebar } from "./sidebar/Sidebar.js";

/**
 * The window, at the point where it can open a library and say what is in it.
 *
 * Deliberately small: the grid, the sidebar, and the inspector are the rest of
 * M3, and each arrives with its own contract members. What this proves is the
 * whole path — renderer to preload to main to engine and back — with the
 * sandbox on.
 *
 * A library is a folder called `<Name>.roost` (ADR-0014). The renderer never
 * builds that path: it sends a location and a name, and the engine — the side
 * with a filesystem — joins them.
 */

interface Opened {
  readonly summary: LibrarySummary;
  readonly stats: LibraryStats;
}

export function App(): React.JSX.Element {
  const [opened, setOpened] = useState<Opened | undefined>();
  const [problem, setProblem] = useState<WireProblem | undefined>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState<string | undefined>();
  const nameField = useRef<HTMLInputElement>(null);
  /**
   * Two counters, because two things go stale at different rates.
   *
   * `generation` changes when a **different library** is open, and the grid
   * throws its pages away on it. `revision` changes on every edit the engine
   * announces, and everything derived — the counts, the sidebar, the match
   * count, the inspector — re-reads on it.
   *
   * Keeping them apart is what stops a keystroke in the note field from
   * re-paging the grid from row one and throwing the scroll position away.
   * The cost is that a *filtered* grid does not drop an asset that has just
   * stopped matching; `TODO.md` §M3 records it, and the fix is a targeted
   * update rather than a reload.
   */
  const [generation, setGeneration] = useState(0);
  const [revision, setRevision] = useState(0);
  const [recent, setRecent] = useState<readonly WireRecentLibrary[]>([]);

  // Focus moved deliberately, in the frame after the form appears, rather than
  // with `autoFocus`: this form opens in response to a click, so putting the
  // caret in it is finishing what the click started.
  useEffect(() => {
    if (creating) nameField.current?.focus();
  }, [creating]);

  /**
   * The counts that decide whether the grid's pages are still valid.
   *
   * A ref rather than reading them back out of `opened` inside a state updater:
   * an updater must be pure, and deciding whether to bump another piece of
   * state inside one is exactly the impurity React is entitled to run twice.
   *
   * Two numbers, not one. `assets` counts every row, trashed ones included, so
   * trashing something leaves it unchanged — and the grid would keep showing an
   * asset that has just stopped matching every query it is in (ADR-0022).
   */
  const lastCounts = useRef<{ assets: number; trashed: number } | undefined>(undefined);

  const readStats = useCallback(async (summary: LibrarySummary, sameLibrary = false) => {
    const stats = await invoke({ type: "library:stats" });
    if (!stats.ok) return setProblem(stats.problem);

    // A different asset count means rows were added or removed — by an import
    // here, by another window, or by the CLI — and the grid's pages are then
    // wrong rather than merely stale. A different trash count means the same
    // thing without the total moving. Anything that leaves both alone (a
    // rating, a note, a tag) does not throw the pages away.
    const rowsChanged =
      !sameLibrary ||
      lastCounts.current?.assets !== stats.value.assets ||
      lastCounts.current?.trashed !== stats.value.trashed;
    lastCounts.current = { assets: stats.value.assets, trashed: stats.value.trashed };

    setProblem(undefined);
    setOpened({ summary, stats: stats.value });
    setRevision((n) => n + 1);
    if (rowsChanged) setGeneration((n) => n + 1);
  }, []);

  // Read whenever the picker could be on screen, including after a library is
  // closed — the one just closed belongs at the top of the list, and asking the
  // engine is cheaper than keeping a second copy in step with it.
  useEffect(() => {
    if (opened !== undefined) return;
    void (async () => {
      const list = await invoke({ type: "recent:list" });
      if (list.ok) setRecent(list.value);
    })();
  }, [opened]);

  // Whatever the engine already holds. A window reopened after a reload finds
  // its library still open, because the engine outlives the page.
  useEffect(() => {
    void (async () => {
      const current = await invoke({ type: "library:current" });
      if (current.ok && current.value !== null) await readStats(current.value);
    })();
  }, [readStats]);

  // The counts are derived, so the only way to keep them true is to re-read
  // them. An event carrying them would be a second copy to keep in step.
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "library:changed" && opened !== undefined) {
          void readStats(opened.summary, true);
        }
      }),
    [opened, readStats],
  );

  /**
   * Opens a library by path.
   *
   * Shared by the dialog and by a recent row rather than written twice: the
   * engine records the open either way, so two call sites would be two chances
   * for them to diverge about what opening means.
   */
  const openPath = async (path: string) => {
    setBusy(true);
    const outcome = await invoke({ type: "library:open", path });
    setBusy(false);
    if (!outcome.ok) {
      setOpened(undefined);
      // The recent list is the likeliest way to reach a library that has been
      // moved since it was last opened, so it is re-read on a failure: the row
      // that just failed comes back marked missing rather than looking fine.
      const list = await invoke({ type: "recent:list" });
      if (list.ok) setRecent(list.value);
      return setProblem(outcome.problem);
    }
    await readStats(outcome.value);
  };

  const openLibrary = async () => {
    setBusy(true);
    const chosen = await invoke({ type: "dialog:openLibrary" });
    setBusy(false);
    if (!chosen.ok) return setProblem(chosen.problem);
    // Cancelled: leave the screen exactly as it was.
    if (chosen.value === null) return;
    await openPath(chosen.value);
  };

  const forget = async (root: string) => {
    const list = await invoke({ type: "recent:forget", root });
    if (list.ok) setRecent(list.value);
  };

  const pin = async (root: string, pinned: boolean) => {
    const list = await invoke({ type: "recent:pin", root, pinned });
    if (list.ok) setRecent(list.value);
  };

  const chooseLocation = async () => {
    const chosen = await invoke({ type: "dialog:chooseLocation" });
    if (!chosen.ok) return setProblem(chosen.problem);
    if (chosen.value !== null) setLocation(chosen.value);
  };

  const save = async () => {
    if (location === undefined || name.trim() === "") return;
    setBusy(true);
    const outcome = await invoke({ type: "library:create", parent: location, name });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);

    setCreating(false);
    setName("");
    setLocation(undefined);
    await readStats(outcome.value);
  };

  const close = async () => {
    await invoke({ type: "library:close" });
    setOpened(undefined);
    setProblem(undefined);
  };

  if (opened !== undefined) {
    return (
      <LibraryView
        opened={opened}
        generation={generation}
        revision={revision}
        onClose={() => void close()}
        onImported={() => void readStats(opened.summary)}
        problem={problem}
      />
    );
  }

  if (creating) {
    return (
      <Frame>
        <section className="panel">
          <h1>New library</h1>
          <p>
            The library is a folder called <code>{fileName(name)}</code>. Everything it holds lives
            inside it, and nothing outside it is ever written to.
          </p>

          <label className="field" htmlFor="library-name">
            <span className="field-label">Name</span>
            <input
              id="library-name"
              placeholder="Holiday Photos"
              spellCheck={false}
              value={name}
              ref={nameField}
              onChange={(changed) => setName(changed.target.value)}
            />
          </label>

          <div className="field">
            <span className="field-label">Location</span>
            <output className="chosen">{location ?? "Not chosen yet"}</output>
            <button type="button" onClick={() => void chooseLocation()}>
              Choose…
            </button>
          </div>

          <div className="actions">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setProblem(undefined);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-variant="primary"
              disabled={busy || location === undefined || name.trim() === ""}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
          {problem !== undefined && <Problem problem={problem} />}
        </section>
      </Frame>
    );
  }

  return (
    <Frame>
      <section className="panel">
        <h1>Roost</h1>
        <p>
          A library is a folder ending in <code>{LIBRARY_SUFFIX}</code>. Open one you already have,
          or make a new one.
        </p>
        <div className="actions">
          <button
            type="button"
            data-variant="primary"
            disabled={busy}
            onClick={() => void openLibrary()}
          >
            Open library…
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCreating(true);
              setProblem(undefined);
            }}
          >
            New library…
          </button>
        </div>
        {problem !== undefined && <Problem problem={problem} />}
        <RecentList
          entries={recent}
          busy={busy}
          onOpen={(root) => void openPath(root)}
          onForget={(root) => void forget(root)}
          onPin={(root, pinned) => void pin(root, pinned)}
        />
      </section>
    </Frame>
  );
}

/** The window frame: whatever is on screen, over the status bar. */
function Frame({
  summary,
  children,
}: {
  readonly summary?: LibrarySummary;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="app">
      {children}
      <footer className="status">
        <span>{summary === undefined ? "No library open" : `schema ${summary.schemaVersion}`}</span>
        <span className="path">{summary?.root ?? ""}</span>
      </footer>
    </div>
  );
}

/**
 * One row for the running job, and one for what it did (`UI_SPEC.md` §3, §8).
 *
 * Progress lives in the status bar rather than in a toast, because a toast is
 * for something that has finished — an import of ninety thousand files is not
 * a notification, it is a state the window is in.
 */
function ImportStatus({ importing }: { readonly importing: Importing }): React.JSX.Element | null {
  if (importing.running) {
    const progress = importing.progress;
    // No percentage: the total is not known until the walk finishes, and a bar
    // that fills to an estimate and then jumps back is worse than a count. The
    // thumbnails are a second phase of the same run and say so.
    const said =
      progress === undefined
        ? "Importing…"
        : progress.thumbnails > 0
          ? `Thumbnails… ${progress.thumbnails.toLocaleString()} of ${progress.imported.toLocaleString()}`
          : `Importing… ${progress.scanned.toLocaleString()} scanned`;
    return <span className="status-job">{said}</span>;
  }

  if (importing.problem !== undefined) {
    return (
      <button type="button" className="status-job" onClick={importing.dismiss}>
        Import failed: {importing.problem.message} [{importing.problem.code}]
      </button>
    );
  }

  const report = importing.report;
  if (report === undefined) return null;
  const parts = [
    `${report.imported.toLocaleString()} imported`,
    ...(report.duplicates + report.partialDuplicates > 0
      ? // Not a failure: identical bytes have one address (invariant 1), so
        // re-importing a folder is the ordinary case.
        [`${(report.duplicates + report.partialDuplicates).toLocaleString()} already here`]
      : []),
    ...(report.failed.length + report.partialCollisions > 0
      ? [`${(report.failed.length + report.partialCollisions).toLocaleString()} failed`]
      : []),
  ];

  return (
    <button type="button" className="status-job" onClick={importing.dismiss}>
      {parts.join(" · ")}
    </button>
  );
}

const EMPTY_LIBRARY = "Nothing in this library yet.";
const NOTHING_MATCHED = "Nothing matches this query.";
// The Trash place is the one query whose empty answer is a *state* rather than
// a failed search — "nothing matches" reads as a query that did not work.
const EMPTY_TRASH = "The trash is empty.";

/** `1,234 assets · 3 selected`, with the second half only when there is one. */
function summaryLine(assets: number | undefined, selected: number): string {
  const total =
    assets === undefined
      ? "counting…"
      : `${assets.toLocaleString()} ${assets === 1 ? "asset" : "assets"}`;
  return selected === 0 ? total : `${total} · ${selected.toLocaleString()} selected`;
}

/**
 * What the folder will be called.
 *
 * A filename, not a path: the renderer has no `node:path` and no business
 * joining one. The suffix comes from the contract, which is the only thing
 * both sides import.
 */
function fileName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? `Name${LIBRARY_SUFFIX}` : `${trimmed}${LIBRARY_SUFFIX}`;
}

function Problem({ problem }: { readonly problem: WireProblem }): React.JSX.Element {
  return (
    <p className="problem" role="alert">
      {problem.message} <code>[{problem.code}]</code>
    </p>
  );
}

/**
 * A library, open: the grid, and a status bar that says what is in it.
 *
 * The paging, the selection, and the layout are the grid's; this is the shell
 * around them. The sidebar and the inspector are the rest of M3 and will take
 * the space either side.
 */
function LibraryView({
  opened,
  generation,
  revision,
  onClose,
  onImported,
  problem,
}: {
  readonly opened: Opened;
  readonly generation: number;
  readonly revision: number;
  readonly onClose: () => void;
  /** An import added rows, so the grid throws its pages away and starts again. */
  readonly onImported: () => void;
  readonly problem: WireProblem | undefined;
}): React.JSX.Element {
  const [view, setView] = useState<GridView>("icons");
  // Icons take the asset's own shape by default: it is the only layout that
  // does not crop, and this is a library of pictures (ADR-0018).
  const [proportional, setProportional] = useState(true);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  /**
   * What the last action said, if it said anything.
   *
   * The status bar rather than a dialog: an export that worked is not worth
   * interrupting anyone for, and one that partly did not is not worth losing.
   * It clears when the selection moves *away from* the one it was written
   * against, which is the next thing a person does after acting on one — so it
   * needs no timer, and nothing disappears while still being read.
   *
   * **Stamped with a selection revision rather than cleared on any change.**
   * Trashing says what it did and then clears the selection, because the assets
   * it named are no longer on screen — and a rule that cleared the line on any
   * change would wipe every message the moment it was written. Found by driving
   * a real window: the note was there before the fix and gone after it.
   */
  const [note, setNote] = useState<{ line: string; at: number } | undefined>();
  const [acted, setActed] = useState<WireProblem | undefined>();
  /**
   * What is on screen, as one string.
   *
   * `UI_SPEC.md` §4.2: there is no separate filter state the search field does
   * not know about. A sidebar row hands over its query and this is where it
   * lands; when the search field arrives, it edits this same string.
   */
  const [query, setQuery] = useState("");
  const [sidebar, setSidebar] = useState<WireSidebar | undefined>();
  const [matches, setMatches] = useState<number | undefined>();
  // One store for the life of the view. A new one per render would drop the
  // selection on every keystroke, and every cell's subscription with it.
  const selection = useMemo(() => new SelectionStore(), []);
  const paging = useAssetPages(query, generation);
  const derives = useDeriveStatus(revision);

  /*
   * Re-read whenever the library changes: the counts are derived, and a stale
   * count beside a live grid is worse than no count. `generation` is the
   * trigger rather than a value the body reads, which is why it looks
   * unnecessary from the outside.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    void (async () => {
      const outcome = await invoke({ type: "library:sidebar" });
      if (outcome.ok) setSidebar(outcome.value);
    })();
  }, [revision]);

  /*
   * The match count is separate work from a page — a page is one screen and a
   * count is every row — so it is asked for once per query rather than once
   * per scroll. `generation` is a trigger here, not a value the body reads.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let current = true;
    setMatches(undefined);
    void (async () => {
      const outcome = await invoke({ type: "assets:count", query });
      if (current && outcome.ok) setMatches(outcome.value);
    })();
    return () => {
      current = false;
    };
  }, [query, revision]);

  const applyQuery = useCallback(
    (picked: string) => {
      // The selection goes with the query: what was selected is no longer on
      // screen (`UI_SPEC.md` §4.2).
      selection.clear();
      setQuery(picked);
    },
    [selection],
  );
  // The library's problem outranks the grid's: a library that failed to open
  // explains an empty grid, and showing both would say the same thing twice.
  // An action's own failure sits between them — it is the most recent thing the
  // user did, but it does not explain a library that never opened.
  const showing = problem ?? acted ?? paging.problem;

  // Subscribed for the wake, not for the value: the count is read straight off
  // the store below, and a revision counter is what makes "deselect one, select
  // another" register as a change at all.
  const selectionRevision = useSyncExternalStore(selection.subscribeRevision, selection.revision);
  const count = selection.size;
  const focused = selection.focused;
  /*
   * The inspector edits the **selection**, not the focused asset — it used to
   * take one hash, and tagging five assets tagged one.
   *
   * Memoised on the revision because the array is what the inspector's read
   * effect depends on: `selected()` allocates a fresh one per call, and passing
   * that straight through would re-read the library on every unrelated render
   * in this window.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is the trigger
  const selected = useMemo(() => selection.selected(), [selection, selectionRevision]);
  const [previewing, setPreviewing] = useState(false);
  /**
   * The one confirmation dialog in the window, and what it is asking about.
   *
   * Held here rather than inside the context menu because `Delete` on the
   * keyboard has to ask the same question the menu item asks, and the menu is
   * not on screen when it is pressed.
   */
  const [confirming, setConfirming] = useState<ConfirmRequest | undefined>();

  // Selecting something else is how a result stops being the current one — but
  // a result written *against* this selection is not stale, which is what an
  // action that clears the selection produces.
  useEffect(() => {
    setNote((current) =>
      current === undefined || current.at === selectionRevision ? current : undefined,
    );
    setActed(undefined);
  }, [selectionRevision]);

  // The end of cold start: not when the window opened, not when the engine
  // replied, but when there is a grid with rows in it (`ROADMAP.md` M3).
  useEffect(() => {
    if (paging.assets.length > 0) markFirstPaint();
  }, [paging.assets.length]);

  /**
   * `Ctrl+1..3` select the views (`UI_SPEC.md` §9, ADR-0018).
   *
   * On the window rather than on the grid, because a view is a property of the
   * window and the grid is not always what has focus — the search field and the
   * inspector both take it, and switching view from either is what a person
   * expects.
   *
   * Which is also why typing is checked for first: `Ctrl+1` means nothing in a
   * text field, but a bare digit does, and a guard that only looked at the
   * modifier would be one shortcut away from eating a keystroke.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && isTyping(target)) return;
      const at = Number(event.key) - 1;
      const chosen = GRID_VIEWS[at];
      if (chosen === undefined) return;
      event.preventDefault();
      setView(chosen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Whether what is on screen is the Trash place.
   *
   * Decided by comparing against the query the **engine** sent for that row,
   * never by writing `is:trashed` here: the renderer assembles no RQL
   * (`UI_SPEC.md` §4.1), and a literal in this file would be a second, worse
   * copy of the grammar that nothing would keep in step.
   */
  const inTrash = useMemo(() => {
    const trash = sidebar?.places.find((place) => place.id === "trash");
    return trash !== undefined && trash.query === query;
  }, [sidebar, query]);

  const noteResult = useCallback(
    (line: string) => {
      setActed(undefined);
      // Read from the store rather than from the subscribed value: the actions
      // clear the selection before saying what they did, so the revision that
      // matters is the one after that clear, and this render has not seen it.
      setNote({ line, at: selection.revision() });
    },
    [selection],
  );

  /**
   * Trashing, restoring, and deleting all take their assets out of the view.
   *
   * The same rule `applyQuery` follows, for the same reason: what was selected
   * is no longer on screen. Without it the status bar says "1 selected" over a
   * grid with nothing highlighted, the inspector goes on editing an asset that
   * is in the trash, and the roving ring has nowhere to return to.
   */
  const clearSelection = useCallback(() => selection.clear(), [selection]);

  const trashing = useTrashActions({
    hashes: selected,
    onNote: noteResult,
    onProblem: setActed,
    onConfirm: setConfirming,
    onGone: clearSelection,
  });

  /**
   * `Delete` on the selection (`UI_SPEC.md` §9).
   *
   * Trash outside the Trash place, delete permanently inside it — the same two
   * meanings the context menu offers, through the same hook, so the shortcut
   * cannot skip a confirmation the menu asks for.
   *
   * On the window rather than on the grid, because the preview and the
   * inspector are both places a person may be looking at the selection from.
   * Typing is checked for first: `Delete` in a text field deletes a character.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Delete" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && isTyping(target)) return;
      if (selected.length === 0) return;
      event.preventDefault();
      if (inTrash) trashing.deletePermanently();
      else trashing.trash();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inTrash, selected, trashing]);

  // An import changes the counts, the sidebar, and what the grid holds, so it
  // is the one thing in the window that has to reset the paging as well.
  const importing = useImport(onImported);

  /**
   * Steps the preview through the loaded list.
   *
   * `selection.click` rather than `selection.focus`, because stepping **changes
   * the selection** (`UI_SPEC.md` §7): in `roost-old` it did not, and a note
   * could be written onto the wrong asset while the preview showed another.
   */
  /**
   * A file that does not exist yet (ADR-0026 §4).
   *
   * Held here rather than in the grid, because it takes the content region the
   * way the preview does: a draft is what the window is showing, not something
   * floating over what it was showing before.
   */
  const [draft, setDraft] = useState<
    { readonly name: string; readonly text: string } | undefined
  >();

  /**
   * Paste (ADR-0026 §5), which is four gestures wearing one name.
   *
   * Main reads the clipboard — the renderer has no ambient authority
   * (invariant 11) — and answers with what it found. Only two of the four
   * import: text opens a draft instead, because a paragraph on the clipboard is
   * something to put in a file rather than a file, and **a link does nothing at
   * all**, because invariant 7 permits one network operation and it is not one
   * a `Ctrl+V` may trigger.
   */
  const paste = useCallback(() => {
    void (async () => {
      const outcome = await invoke({ type: "clipboard:paste", mode: "managed" });
      if (!outcome.ok) return setActed(outcome.problem);

      const pasted = outcome.value;
      if (pasted.kind === "imported") {
        onImported();
        return noteResult(
          pasted.report.imported === 0
            ? "Nothing new — those files are already in the library"
            : `Pasted ${pasted.report.imported} of ${pasted.report.scanned} files`,
        );
      }
      if (pasted.kind === "text") return setDraft({ name: DEFAULT_TEXT_NAME, text: pasted.text });
      if (pasted.kind === "url") {
        return noteResult("Pasting never fetches a link — import it deliberately instead");
      }
      return noteResult("Nothing on the clipboard");
    })();
  }, [noteResult, onImported]);

  const step = useCallback(
    (delta: -1 | 1) => {
      const order = paging.assets.map((asset) => asset.hash);
      const at = focused === undefined ? -1 : order.indexOf(focused);
      const next = order[at + delta];
      // Stops at the ends rather than wrapping. A wrap here is a jump of
      // thousands of rows, which is not what an arrow key means anywhere else.
      if (next !== undefined) selection.click(next);
    },
    [paging.assets, focused, selection],
  );

  return (
    <div className="app app-library">
      <header className="bar">
        <h1 className="bar-title">{opened.summary.name}</h1>
        <SearchField query={query} onApply={applyQuery} matches={matches} />
        <div className="bar-actions">
          <ViewMenu
            view={view}
            proportional={proportional}
            zoom={zoom}
            onView={setView}
            onProportional={setProportional}
            onZoom={(steps) => setZoom((at) => (steps === 0 ? DEFAULT_ZOOM : zoomBy(at, steps)))}
          />
          <button
            type="button"
            disabled={importing.running}
            onClick={() => {
              void (async () => {
                const chosen = await invoke({ type: "dialog:chooseImport" });
                if (chosen.ok && chosen.value !== null) importing.start(chosen.value);
              })();
            }}
          >
            Import…
          </button>
          <button type="button" onClick={onClose}>
            Close library
          </button>
        </div>
      </header>

      <div className="workspace">
        {/* Clicking a row replaces the query (`UI_SPEC.md` §4.2), and the search
            field shows what it was replaced with — one source of truth for what
            is on screen, and it is a string the user can read and edit. */}
        {sidebar !== undefined && <Sidebar sidebar={sidebar} query={query} onPick={applyQuery} />}
        {draft !== undefined ? (
          <DraftEditor
            initialName={draft.name}
            initialText={draft.text}
            onCancel={() => setDraft(undefined)}
            onProblem={setActed}
            onSaved={(hash, created, name) => {
              setDraft(undefined);
              onImported();
              // Selected rather than merely made: the file a person just wrote
              // is what they are looking at, and the inspector is where they
              // would tag it.
              selection.click(hash);
              noteResult(created ? `Saved ${name}` : `${name} holds bytes the library already had`);
            }}
          />
        ) : previewing && focused !== undefined ? (
          /* Over the asset on screen, not over the selection: "export…" while
             looking at one picture cannot sensibly mean the other eleven. */
          <AssetContextMenu
            hashes={[focused]}
            inTrash={inTrash}
            onNote={noteResult}
            onProblem={setActed}
            onConfirm={setConfirming}
            onGone={clearSelection}
            onPosterPinned={paging.pinPoster}
          >
            <PreviewPane
              hash={focused}
              generation={revision}
              onClose={() => setPreviewing(false)}
              onStep={step}
              // Saving an edit makes a new asset (ADR-0026), so the selection
              // follows it: the pane shows what is selected, and leaving the
              // selection on the version that was just replaced would put an
              // old one back on screen the moment anything re-read.
              onReplaced={(hash) => selection.click(hash)}
            />
          </AssetContextMenu>
        ) : paging.assets.length === 0 && paging.done ? (
          /* The menu over nothing belongs here most of all: an empty library is
             exactly where somebody wants to paste or make a file. */
          <AssetContextMenu
            hashes={[]}
            inTrash={inTrash}
            onNote={noteResult}
            onProblem={setActed}
            onConfirm={setConfirming}
            onGone={clearSelection}
            onPaste={paste}
            onNewFile={(name) => setDraft({ name, text: "" })}
          >
            <p className="grid-empty">
              {query === "" ? EMPTY_LIBRARY : inTrash ? EMPTY_TRASH : NOTHING_MATCHED}
            </p>
          </AssetContextMenu>
        ) : (
          <AssetContextMenu
            hashes={selected}
            inTrash={inTrash}
            onNote={noteResult}
            onProblem={setActed}
            onConfirm={setConfirming}
            onGone={clearSelection}
            onPaste={paste}
            onNewFile={(name) => setDraft({ name, text: "" })}
          >
            <Grid
              assets={paging.assets}
              view={view}
              proportional={proportional}
              target={zoom}
              selection={selection}
              onMore={paging.more}
              onOpen={() => setPreviewing(true)}
            />
          </AssetContextMenu>
        )}
        <Inspector hashes={selected} generation={revision} />
      </div>

      <DropZone onDrop={importing.start} />

      <footer className="status">
        {/* One text node, so what the status bar says is one readable string
            rather than four fragments a screen reader has to reassemble. */}
        {/* `assets` counts every row, trashed ones included, so the live total
            is the difference — the same number the empty query answers with,
            without a round trip and without a flash of "counting…". */}
        <span>
          {summaryLine(query === "" ? opened.stats.assets - opened.stats.trashed : matches, count)}
        </span>
        {note !== undefined && (
          <span className="status-note" aria-live="polite">
            {note.line}
          </span>
        )}
        <ImportStatus importing={importing} />
        <DeriveStatus status={derives.status} onRetry={(reason) => void derives.retry(reason)} />
        <span className="path">{opened.summary.root}</span>
      </footer>
      {showing !== undefined && <Problem problem={showing} />}
      <ConfirmDialog
        open={confirming !== undefined}
        title={confirming?.title ?? ""}
        body={confirming?.body ?? ""}
        confirmLabel={confirming?.confirmLabel ?? ""}
        onConfirm={() => {
          confirming?.run();
          setConfirming(undefined);
        }}
        onCancel={() => setConfirming(undefined)}
      />
    </div>
  );
}

/** Whether a keystroke belongs to whatever the user is typing into. */
function isTyping(element: HTMLElement): boolean {
  return (
    element.isContentEditable ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  );
}
