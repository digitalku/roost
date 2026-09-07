import type {
  AssetCard,
  ImportSubject,
  LibraryStats,
  LibrarySummary,
  SidebarFolderRow,
  SidebarRow,
  SidebarTypeRow,
  WireEagleReport,
  WireFacets,
  WireProblem,
  WireRecentLibrary,
  WireSidebar,
  WireSplitQuery,
  WireTagRule,
} from "@roost/contract";
import { LIBRARY_SUFFIX } from "@roost/contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import wordmark from "../../../../assets/brand/roost-logo-dark.svg";
import { AddMenu } from "./AddMenu.js";
import { AppMenu } from "./AppMenu.js";
import { markFirstPaint } from "./bench/bench.js";
import { invoke, onEvent } from "./bridge.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DeriveStatus, useDeriveStatus } from "./DeriveStatus.js";
import { FilterBar } from "./filter/FilterBar.js";
import { AssetContextMenu } from "./grid/AssetContextMenu.js";
import { Grid } from "./grid/Grid.js";
import { DEFAULT_ZOOM, GRID_VIEWS, type GridView, zoomBy } from "./grid/layout.js";
import { useAssetPages } from "./grid/paging.js";
import { SelectionStore } from "./grid/selection.js";
import { assets, type ConfirmRequest, useTrashActions } from "./grid/trash-actions.js";
import { ViewMenu } from "./grid/ViewMenu.js";
import { DropZone } from "./import/DropZone.js";
import { EagleDialog } from "./import/EagleDialog.js";
import { type Importing, useImport } from "./import/useImport.js";
import { Inspector } from "./inspector/Inspector.js";
import { RecentList } from "./library/RecentList.js";
import { NewFileDialog } from "./NewFileDialog.js";
import { PreviewPane } from "./preview/PreviewPane.js";
import { useReclaim } from "./reclaim.js";
import { SearchField } from "./search/SearchField.js";
import { useExpansion } from "./sidebar/expansion.js";
import { FolderDialog, type FolderDialogProps } from "./sidebar/FolderDialog.js";
import { Sidebar } from "./sidebar/Sidebar.js";

/**
 * A query nobody has read yet: no place, no facets, and describable.
 *
 * The starting state of the filter bar, and what a failed read leaves standing.
 * Frozen at module scope so it is one object — it is a `useState` initial value
 * and a ref's, and a fresh one per render would be a fresh dependency too.
 */
const NO_SPLIT: WireSplitQuery = {
  place: "",
  facets: { tags: [], tagRule: "any", stars: [], unrated: false, exts: [] },
  representable: true,
};

/**
 * Whether the query itself says how the tags are joined (ADR-0035 §7.2).
 *
 * Below two tags it does not — `tag:olahraga` is the same string under either
 * rule — and the window's own memory is what fills in.
 */
function ruleIsInTheQuery(facets: WireFacets): boolean {
  return facets.tags.length >= 2;
}

/**
 * The facets a picked row implies, over the ones already on.
 *
 * Per facet, not per set: a folder row names no tags, so its click leaves the
 * tag filter standing, while a tag chip names one and replaces it. Which is
 * what "replaces every conjunct the bar does not own" means when the thing
 * being picked happens to own one (ADR-0035 §6).
 */
function merge(held: WireFacets, picked: WireFacets): WireFacets {
  const rating = picked.stars.length > 0 || picked.unrated;
  return {
    tags: picked.tags.length > 0 ? picked.tags : held.tags,
    // A row that names one tag says nothing about the rule, so the one on
    // screen stands. A row that names two does say, and then it wins.
    tagRule: ruleIsInTheQuery(picked) ? picked.tagRule : held.tagRule,
    stars: rating ? picked.stars : held.stars,
    unrated: rating ? picked.unrated : held.unrated,
    exts: picked.exts.length > 0 ? picked.exts : held.exts,
  };
}

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
   * The cost is paid twice, and the answer to both is a targeted update rather
   * than a reload: a card the grid holds can go stale in itself — a pinned
   * poster, a rename — which `paging.pinPoster` and `paging.rename` put right,
   * and a *filtered* grid does not drop an asset that has just stopped
   * matching, which `paging.drop` answers only for `Ctrl+Delete`. `TODO.md`
   * §M3 records what is left.
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
        {/*
          The wordmark rather than the word. `assets/brand/` holds both
          variants; this is the one for a dark ground, which is the only ground
          the window has while `index.html` pins the theme (`TODO.md` §3). When
          the theme follows the system, this becomes a pair.
        */}
        <h1 className="brand">
          <img src={wordmark} alt="Roost" width={235} height={64} draggable={false} />
        </h1>
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
    // What is *finished*, over what is known to be there. `scanned` alone was
    // the walk's own queue — it jumps by a batch of five hundred and then sits
    // still, which reads as five hundred files done in an instant.
    const done =
      progress === undefined ? 0 : progress.imported + progress.duplicates + progress.failed;
    const said =
      progress === undefined
        ? "Importing…"
        : progress.thumbnails > 0
          ? `Thumbnails… ${progress.thumbnails.toLocaleString()} of ${progress.imported.toLocaleString()}`
          : // The denominator is the total where one is known — an Eagle import
            // counted its items before it began (ADR-0032) — and otherwise what
            // the walk has found so far, which is the honest upper bound.
            `Importing… ${done.toLocaleString()} of ${(progress.total ?? progress.scanned).toLocaleString()}`;
    return <span className="status-job">{said}</span>;
  }

  if (importing.problem !== undefined) {
    return (
      <button type="button" className="status-job" onClick={importing.dismiss}>
        Import failed: {importing.problem.message} [{importing.problem.code}]
      </button>
    );
  }

  const outcome = importing.outcome;
  if (outcome === undefined) return null;
  if (outcome.kind === "eagle") {
    return (
      <button type="button" className="status-job" onClick={importing.dismiss}>
        {eagleSaid(outcome.report).join(" · ")}
      </button>
    );
  }

  const report = outcome.report;
  const parts = [
    `${report.imported.toLocaleString()} imported`,
    ...(report.duplicates + report.partialDuplicates > 0
      ? // Not a failure: identical bytes have one address (invariant 1), so
        // re-importing a folder is the ordinary case.
        [`${(report.duplicates + report.partialDuplicates).toLocaleString()} already here`]
      : []),
    ...(report.subtitles > 0
      ? // An attachment nobody asked for by name, made from a filename
        // (ADR-0025 §3) — so the run says it happened.
        [`${report.subtitles.toLocaleString()} captioned`]
      : []),
    ...(report.subtitlesUnattached > 0
      ? [`${report.subtitlesUnattached.toLocaleString()} subtitles unattached`]
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

/**
 * What an Eagle import says in the status bar (ADR-0032).
 *
 * The same rule the path import's line follows: only what happened. A library
 * with no comments must not produce "0 comments" — a zero here is a sentence
 * about something the user does not use.
 *
 * `collapsed` is the exception that is always worth saying when it is not zero,
 * because a lower asset count than item count reads as data loss until it is
 * explained.
 */
function eagleSaid(report: WireEagleReport): string[] {
  return [
    `${report.assets.toLocaleString()} from Eagle`,
    ...(report.duplicates > 0 ? [`${report.duplicates.toLocaleString()} already here`] : []),
    ...(report.collapsed > 0 ? [`${report.collapsed.toLocaleString()} merged by content`] : []),
    ...(report.folders > 0 ? [`${report.folders.toLocaleString()} folders`] : []),
    ...(report.comments > 0 ? [`${report.comments.toLocaleString()} comments`] : []),
    ...(report.subtitles > 0 ? [`${report.subtitles.toLocaleString()} captioned`] : []),
    ...(report.trashed > 0 ? [`${report.trashed.toLocaleString()} trashed`] : []),
    ...(report.failed.length > 0 ? [`${report.failed.length.toLocaleString()} failed`] : []),
  ];
}

/**
 * Whether Roost can draw this asset itself, or the desktop has to.
 *
 * `other` is the whole test (`UI_SPEC.md` §6): everything Roost has a backend
 * for opens in the window, even while its thumbnail is still being derived.
 * One function, because the double-click and the context menu must agree — a
 * menu whose first row is not what the gesture does is a menu that teaches the
 * wrong thing.
 */
function drawable(assets: readonly AssetCard[], hash: string): boolean {
  const card = assets.find((asset) => asset.hash === hash);
  return card !== undefined && card.kind !== "other";
}

/** Whether an asset is the kind a caption track can be attached to (ADR-0025). */
function captionable(assets: readonly AssetCard[], hash: string | undefined): boolean {
  if (hash === undefined) return false;
  const card = assets.find((asset) => asset.hash === hash);
  return card !== undefined && (card.kind === "video" || card.kind === "audio");
}

/** Before the first sidebar read lands. A fresh `[]` per render is a new memo. */
const NO_TAGS: readonly SidebarRow[] = [];
const NO_FOLDERS: readonly SidebarFolderRow[] = [];
const NO_TYPES: readonly SidebarTypeRow[] = [];

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
  /**
   * The query, read as a place plus the three facets the bar draws (ADR-0035).
   *
   * Derived from `query` and never edited directly — the bar is a **view** of
   * the query, so this follows the string rather than the string following it.
   * Until the first answer arrives it is the empty split, which draws a bar with
   * nothing chosen: the honest state for a query nobody has read yet.
   */
  const [split, setSplit] = useState<WireSplitQuery>(NO_SPLIT);
  /**
   * How the tag facet joins its values, when the query does not say
   * (ADR-0035 §7.2).
   *
   * The one part of the bar that is not read back out of the query, and
   * deliberately the one part the query cannot express: with fewer than two
   * tags both rules spell the same string. It has the standing the view mode
   * and the zoom have (ADR-0018) — window state, because nothing in the query
   * describes it — and the moment a second tag makes it expressible the string
   * wins, below.
   */
  const [tagRule, setTagRule] = useState<WireTagRule>("any");
  const [sidebar, setSidebar] = useState<WireSidebar | undefined>();
  const [matches, setMatches] = useState<number | undefined>();
  // One store for the life of the view. A new one per render would drop the
  // selection on every keystroke, and every cell's subscription with it.
  const selection = useMemo(() => new SelectionStore(), []);
  const paging = useAssetPages(query, generation);
  const dropRows = paging.drop;
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

  /*
   * The bar reads the query, and the engine does the reading: the grammar has
   * one implementation and it is not in the sandbox (`UI_SPEC.md` §4.1). A
   * query that is still in flight leaves the last answer on screen rather than
   * blanking the chips, which would flicker on every keystroke.
   */
  useEffect(() => {
    let current = true;
    void (async () => {
      const outcome = await invoke({ type: "query:split", query });
      if (current && outcome.ok) setSplit(outcome.value);
    })();
    return () => {
      current = false;
    };
  }, [query]);

  // The query wins whenever it can speak. Typing `tag:a tag:b` by hand moves the
  // toggle, which is what makes the bar a view of the query rather than a thing
  // beside it.
  useEffect(() => {
    if (ruleIsInTheQuery(split.facets)) setTagRule(split.facets.tagRule);
  }, [split]);

  /** What the bar draws and what a join is built from: the query, then memory. */
  const facets = useMemo(
    () => (ruleIsInTheQuery(split.facets) ? split.facets : { ...split.facets, tagRule }),
    [split.facets, tagRule],
  );

  const applyQuery = useCallback(
    (picked: string) => {
      // The selection goes with the query: what was selected is no longer on
      // screen (`UI_SPEC.md` §4.2).
      selection.clear();
      setQuery(picked);
    },
    [selection],
  );

  /**
   * What the query is, without the callbacks below re-forming on every change.
   *
   * Both of them are handed to memoised children — the pane and the bar — and a
   * callback that changed identity whenever a facet did would re-render the
   * whole navigation tree on every tick of a checkbox.
   */
  const held = useRef(NO_SPLIT);
  held.current = split;
  const heldFacets = useRef<WireFacets>(NO_SPLIT.facets);
  heldFacets.current = facets;

  /** A facet was ticked: the place stands, the facets are the new ones. */
  const applyFacets = useCallback(
    (chosen: WireFacets) => {
      // Remembered even when the query is about to say it: the query's answer
      // arrives one round trip later, and a toggle that waited for it would
      // flick back for a frame.
      setTagRule(chosen.tagRule);
      void (async () => {
        const outcome = await invoke({
          type: "query:join",
          place: held.current.place,
          facets: chosen,
        });
        if (outcome.ok) applyQuery(outcome.value);
      })();
    },
    [applyQuery],
  );

  /**
   * A row was clicked — in the pane, or on a chip in the inspector.
   *
   * **It replaces every conjunct the bar does not own and leaves the ones it
   * does** (ADR-0035 §6). One rule for all three sections: a folder becomes the
   * new place and the filters stand; a chip that names a tag becomes the tag
   * facet and the rating and type filters stand; **All assets** carries the
   * empty query and so clears the place and nothing else.
   *
   * Two round trips for one click, both pure functions of a string. The
   * alternative is a renderer that knows which half of a query is which, which
   * is the thing this design exists to avoid.
   */
  const pickQuery = useCallback(
    (picked: string) => {
      void (async () => {
        const read = await invoke({ type: "query:split", query: picked });
        if (!read.ok) return applyQuery(picked);
        const merged = merge(heldFacets.current, read.value.facets);
        setTagRule(merged.tagRule);
        const joined = await invoke({
          type: "query:join",
          place: read.value.place,
          facets: merged,
        });
        applyQuery(joined.ok ? joined.value : picked);
      })();
    },
    [applyQuery],
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
  /**
   * The confirm dialog's optional second answer (ADR-0033).
   *
   * Here rather than in `ConfirmRequest`, because the request is built before
   * the box exists and read after it is ticked. It goes back to `false` with
   * every new request: an option carried over from the last dialog is an answer
   * nobody gave.
   */
  const [optionOn, setOptionOn] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request is the trigger
  useEffect(() => setOptionOn(false), [confirming]);

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

  /**
   * A file is open in the pane.
   *
   * One expression rather than two readings of the same two variables: the head
   * of the content column is hidden by exactly what puts the preview there, or
   * a state with `previewing` set and nothing focused would take the bar away
   * and leave the grid behind it.
   */
  const showingPreview = previewing && focused !== undefined;

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

  const reclaim = useReclaim({
    onNote: noteResult,
    onProblem: setActed,
    onConfirm: setConfirming,
  });

  /**
   * The folder whose contents are on screen, if one is.
   *
   * Matched on the query the **engine** sent for that row, exactly as `inTrash`
   * is and never by writing `folder:` here: the renderer assembles no RQL
   * (`UI_SPEC.md` §4.1). A folder reached by typing its query into the search
   * field is the same folder by this test, which is right — what is on screen
   * is what the shortcut acts on.
   */
  const openFolder = useMemo(
    () => sidebar?.folders.find((folder) => folder.query === query),
    [sidebar, query],
  );

  /**
   * `Ctrl+Delete` takes the selection out of the folder being looked at
   * (`UI_SPEC.md` §9).
   *
   * **Not a delete of any kind.** A folder is a collection, so leaving one
   * changes nothing about the asset and nothing on disk — which is why this
   * asks for no confirmation while the bare `Delete` beside it does. The
   * keystroke pairs them because they are the two ways something stops being
   * here, and the modifier is the weaker one.
   *
   * It does nothing outside a folder, deliberately: there is no folder to name,
   * and guessing at one — the first the asset happens to be in — would be a
   * removal nobody asked for. The panel's chips are where a folder is named.
   */
  useEffect(() => {
    if (openFolder === undefined) return;
    const folder = openFolder.folder;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Delete" || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && isTyping(target)) return;
      if (selected.length === 0) return;
      event.preventDefault();
      void invoke({ type: "asset:folderRemove", hashes: selected, folder }).then((outcome) => {
        if (!outcome.ok) return setActed(outcome.problem);
        // The grid re-pages only when the library's counts move, and this moves
        // neither — the assets are still there and still live. Without the drop
        // they stay on screen in a folder they have just left, which is the
        // status bar and the grid saying different things. Found in a real
        // window on 2026-09-07.
        dropRows(selected);
        // The same order the trash actions keep: what was acted on has left
        // the view, so the selection goes before the line that reports it.
        clearSelection();
        noteResult(`Removed ${assets(selected.length)} from ${openFolder.name}`);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFolder, selected, clearSelection, noteResult, dropRows]);

  /** Which folder branches are open. Held here so a new one can be revealed. */
  const expansion = useExpansion();
  const reveal = expansion.reveal;

  /** The folder being named, if one is (ADR-0033). */
  const [naming, setNaming] = useState<FolderDialogProps["what"] | undefined>();

  const newFolder = useCallback((parent: SidebarFolderRow | null) => {
    setNaming({
      kind: "create",
      parent: parent === null ? null : parent.folder,
      under: parent === null ? null : parent.path,
    });
  }, []);

  const renameFolder = useCallback((folder: SidebarFolderRow) => {
    setNaming({ kind: "rename", folder: folder.folder, name: folder.name });
  }, []);

  /**
   * Deleting a folder, and the one question that goes with it (ADR-0033).
   *
   * The count in the body is the row's own, which is a **subtree** count — the
   * same number the sidebar is showing beside the folder, and the number of
   * assets the ticked box would move. Taking it from the row rather than asking
   * the engine keeps the dialog instant and keeps the two from disagreeing.
   */
  const deleteFolder = useCallback(
    (folder: SidebarFolderRow) => {
      const held = folder.count ?? 0;
      setConfirming({
        title: `Delete ${folder.name}?`,
        body:
          held === 0
            ? "The folder goes. Nothing else changes."
            : `The folder goes, and its subfolders with it. The ${assets(held)} in it stay in the library unless you say otherwise below.`,
        confirmLabel: "Delete folder",
        ...(held === 0 ? {} : { option: { label: `Also move ${assets(held)} to the trash` } }),
        run: (trashContents) => {
          void invoke({ type: "folder:delete", folder: folder.folder, trashContents }).then(
            (outcome) => {
              if (!outcome.ok) return setActed(outcome.problem);
              // The query on screen names a folder that no longer exists, so
              // the grid would go on showing rows nothing can ask for again.
              if (query === folder.query) applyQuery("");
              noteResult(
                outcome.value.trashed === 0
                  ? `Deleted ${folder.name}. The assets in it are still in the library.`
                  : `Deleted ${folder.name}, and moved ${assets(outcome.value.trashed)} to the trash`,
              );
            },
          );
        },
      });
    },
    [query, applyQuery, noteResult],
  );

  /**
   * Assets dropped on a folder row (`UI_SPEC.md` §4.3).
   *
   * **Whether this is a move is decided here**, not in the pane: a folder is a
   * collection rather than a location, so there is nothing to move *out of*
   * unless a folder is on screen. Dropping from `All assets` or from a search
   * adds; dropping from inside a folder moves, because that is what the gesture
   * means to the hand that made it. `Ctrl` forces the add, as it does in a file
   * manager.
   *
   * Two requests rather than one, and deliberately in this order: the add is
   * what was asked for, and a failure between them leaves the assets in both
   * folders — visible, harmless, and undone by dragging again. The reverse
   * order could lose them from both.
   */
  const dropOnFolder = useCallback(
    (folder: SidebarFolderRow, hashes: readonly string[], copy: boolean) => {
      const from = copy || openFolder === undefined ? undefined : openFolder;
      if (from?.folder === folder.folder) return;

      void (async () => {
        const added = await invoke({ type: "asset:folderAdd", hashes, folder: folder.folder });
        if (!added.ok) return setActed(added.problem);
        if (from === undefined) {
          noteResult(`Added ${assets(hashes.length)} to ${folder.name}`);
          return;
        }
        const removed = await invoke({
          type: "asset:folderRemove",
          hashes,
          folder: from.folder,
        });
        if (!removed.ok) return setActed(removed.problem);
        // They have left the view they were dragged out of, so the same
        // targeted drop `Ctrl+Delete` needs applies here (`paging.drop`).
        dropRows(hashes);
        clearSelection();
        noteResult(`Moved ${assets(hashes.length)} from ${from.name} to ${folder.name}`);
      })();
    },
    [openFolder, dropRows, clearSelection, noteResult],
  );

  /** A folder dropped on another, or on the heading (`null` is the top level). */
  const moveFolder = useCallback((folder: number, parent: number | null) => {
    void invoke({ type: "folder:move", folder, parent }).then((outcome) => {
      // The refusal that matters is a cycle, and it has to be seen: the pane
      // offered the drop, so a silent no reads as a gesture that did nothing.
      if (!outcome.ok) setActed(outcome.problem);
    });
  }, []);

  /** The Eagle library the survey dialog is open on, if it is (ADR-0032). */
  const [eagle, setEagle] = useState<string | undefined>();

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
  const startImport = importing.start;
  const importRunning = importing.running;

  /**
   * The two import doors, which differ only in the chooser main opens.
   *
   * Asking which was meant *before* the dialog is what makes the folder case
   * work at all: a chooser given both `openFile` and `openDirectory` is drawn
   * as a file chooser everywhere, so a folder had to be selected from its
   * parent — the one view that does not show its contents.
   */
  const chooseAndImport = useCallback(
    (what: ImportSubject) => {
      if (importRunning) return;
      void (async () => {
        const chosen = await invoke({ type: "dialog:chooseImport", what });
        if (chosen.ok && chosen.value !== null) startImport(chosen.value);
      })();
    },
    [importRunning, startImport],
  );

  /**
   * **Import from Eagle…** (ADR-0032): choose a library, then look at it.
   *
   * Two steps, and the chooser is the first because the survey has nothing to
   * survey without a path. The dialog that follows selects nothing — the import
   * brings everything — so it exists to say what is about to happen, including
   * what will not come across.
   */
  const chooseEagle = useCallback(() => {
    if (importRunning) return;
    void (async () => {
      const chosen = await invoke({ type: "dialog:chooseEagle" });
      if (chosen.ok && chosen.value !== null) setEagle(chosen.value);
    })();
  }, [importRunning]);

  /**
   * `Ctrl+I` and `Ctrl+Shift+I` (`UI_SPEC.md` §10).
   *
   * Not guarded on whether something is being typed into, unlike `Ctrl+1..3`:
   * that guard exists because a bare digit is a character, and `Ctrl+I` is not
   * one — it does nothing in a plain input, so importing from the search field
   * is a shortcut working rather than a keystroke being eaten.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "i") return;
      event.preventDefault();
      chooseAndImport(event.shiftKey ? "folders" : "files");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chooseAndImport]);

  /**
   * Steps the preview through the loaded list.
   *
   * `selection.click` rather than `selection.focus`, because stepping **changes
   * the selection** (`UI_SPEC.md` §7): in `roost-old` it did not, and a note
   * could be written onto the wrong asset while the preview showed another.
   */
  /**
   * The New file dialog, and what it opens with (ADR-0026 §4).
   *
   * A dialog rather than a pane: naming the file is the question, and a form
   * that asks it is a smaller thing than an editor — which the window
   * deliberately does not have, because an external one is enough.
   */
  const [newFile, setNewFile] = useState<
    { readonly name: string; readonly text: string } | undefined
  >();

  /** Opens the dialog empty, which is what every door but one wants. */
  const composeFile = useCallback(() => setNewFile({ name: "", text: "" }), []);

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
  /**
   * A drop, offered to the open video before it is offered to the import.
   *
   * **The rule is what is open, not where the pointer is.** A subtitle dropped
   * while a film is on screen is for that film — the window cannot know what a
   * drag holds until it lands (Chromium reports no filename during a drag), so
   * a target that lit up only over the video would be an affordance that
   * appears after the decision is made. The overlay says what will happen
   * instead.
   *
   * The engine decides what counts as a subtitle and hands back the paths it
   * declined, which then go to the import they were always going to. Nothing is
   * dropped on the floor, and the renderer never learns an extension list that
   * belongs to `@roost/media`.
   */
  const dropped = useCallback(
    (paths: readonly string[]) => {
      const film = showingPreview ? focused : undefined;
      if (!captionable(paging.assets, film) || film === undefined) {
        importing.start(paths);
        return;
      }

      void (async () => {
        const outcome = await invoke({ type: "asset:addSubtitle", hash: film, paths });
        if (!outcome.ok) return setActed(outcome.problem);

        const { attached, ignored } = outcome.value;
        if (attached > 0) {
          noteResult(attached === 1 ? "Subtitle attached" : `${attached} subtitles attached`);
        }
        if (ignored.length > 0) importing.start(ignored);
      })();
    },
    [showingPreview, focused, paging.assets, importing, noteResult],
  );

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
      // Words on the clipboard are something to put in a file rather than a
      // file, so they arrive as the new file's contents and still want a name.
      if (pasted.kind === "text") return setNewFile({ name: "", text: pasted.text });
      if (pasted.kind === "url") {
        return noteResult("Pasting never fetches a link — import it deliberately instead");
      }
      return noteResult("Nothing on the clipboard");
    })();
  }, [noteResult, onImported]);

  /**
   * Opening an asset — from `Enter`, or from a double-click.
   *
   * **A file Roost cannot draw goes straight to the application that owns it**
   * (`UI_SPEC.md` §6). Opening a preview that can only offer "Open externally"
   * is a pane in the way of the thing the gesture meant, and the kind travels
   * on the card so the decision costs no round trip.
   */
  const openAsset = useCallback(
    (hash: string) => {
      if (!drawable(paging.assets, hash)) {
        void invoke({ type: "asset:openExternally", hash });
        return;
      }
      setPreviewing(true);
    },
    [paging.assets],
  );

  /*
   * Where the open asset sits in the loaded list, for the head's two arrows.
   *
   * Only while the preview is open, because this walks the page and the grid
   * re-renders on every scroll — and while the grid is what is on screen, there
   * is nothing to draw the answer on.
   */
  const stepAt = showingPreview ? paging.assets.findIndex((asset) => asset.hash === focused) : -1;

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
      <div className="workspace">
        {/*
          The sidebar runs to the top of the window and carries its own head,
          rather than starting under a toolbar that spans everything
          (`UI_SPEC.md` §1). The library's name belongs to the library, which is
          what this column is; the search field belongs to the grid, which is
          what the middle column is.
        */}
        <div className="pane-sidebar">
          <header className="bar bar-sidebar">
            <AppMenu
              onCloseLibrary={onClose}
              onReclaim={reclaim}
              onQuit={() => {
                void invoke({ type: "app:quit" });
              }}
            />
            <h1 className="bar-title">{opened.summary.name}</h1>
          </header>
          {/* Clicking a row replaces where the query looks and leaves the bar's
              three filters standing (ADR-0035 §6), and the search field shows
              the result — one source of truth for what is on screen, and it is
              a string the user can read and edit. */}
          {sidebar !== undefined && (
            <Sidebar
              sidebar={sidebar}
              query={query}
              onPick={pickQuery}
              expansion={expansion}
              onNewFolder={newFolder}
              onRenameFolder={renameFolder}
              onDeleteFolder={deleteFolder}
              onDropAssets={dropOnFolder}
              onMoveFolder={moveFolder}
            />
          )}
        </div>

        <div className="pane-content">
          {/*
            Not while a file is open. Every control in this head is the grid's —
            the search field, the view menu, the import — and the grid is not on
            screen; the preview brings its own head, with the file's name and
            the way out. A bar of controls for something you cannot see is one
            more thing to read past (`UI_SPEC.md` §7).
          */}
          {!showingPreview && (
            <>
              <header className="bar">
                {/* The field is edited directly and the bar is derived from it, so
                  typing goes to `applyQuery` and every row and chip goes through
                  `pickQuery`, which keeps the filters standing (ADR-0035 §6). */}
                <SearchField query={query} onApply={applyQuery} matches={matches} />
                <div className="bar-actions">
                  <ViewMenu
                    view={view}
                    proportional={proportional}
                    zoom={zoom}
                    onView={setView}
                    onProportional={setProportional}
                    onZoom={(steps) =>
                      setZoom((at) => (steps === 0 ? DEFAULT_ZOOM : zoomBy(at, steps)))
                    }
                  />
                  <AddMenu
                    busy={importing.running}
                    onNewFile={composeFile}
                    onNewTextDocument={() => setNewFile({ name: ".txt", text: "" })}
                    onImportFiles={() => chooseAndImport("files")}
                    onImportFolder={() => chooseAndImport("folders")}
                    onImportEagle={chooseEagle}
                  />
                </div>
              </header>
              {/* A row of its own under the toolbar, and always drawn (ADR-0035
                §3.6): with the pane's rating and tag sections gone, this is the
                only thing on screen that can say a filter is on. */}
              <FilterBar
                facets={facets}
                representable={split.representable}
                tags={sidebar?.tags ?? NO_TAGS}
                ratings={sidebar?.ratings ?? NO_TAGS}
                types={sidebar?.types ?? NO_TYPES}
                onChange={applyFacets}
              />
            </>
          )}

          {showingPreview ? (
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
                hasPrevious={stepAt > 0}
                hasNext={stepAt >= 0 && stepAt + 1 < paging.assets.length}
                onClose={() => setPreviewing(false)}
                onStep={step}
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
              onNewFile={composeFile}
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
              onNewFile={composeFile}
              onOpenHere={(hash) => {
                selection.click(hash);
                setPreviewing(true);
              }}
              drawable={selected.length === 1 && drawable(paging.assets, selected[0] ?? "")}
            >
              <Grid
                assets={paging.assets}
                view={view}
                proportional={proportional}
                target={zoom}
                selection={selection}
                onMore={paging.more}
                onOpen={openAsset}
              />
            </AssetContextMenu>
          )}
        </div>

        {/* The sidebar's rows are the two vocabularies the panel edits with —
            the window already holds every tag with its count and every folder
            with its id, so neither the suggestion nor the folder menu costs a
            request. */}
        <Inspector
          hashes={selected}
          generation={revision}
          vocabulary={sidebar?.tags ?? NO_TAGS}
          folders={sidebar?.folders ?? NO_FOLDERS}
          onRenamed={paging.rename}
          onPick={pickQuery}
        />
      </div>

      {/* Mounted only while it is open, so the contents a paste handed it are
          the state it starts with rather than something to synchronise. */}
      {newFile !== undefined && (
        <NewFileDialog
          initialName={newFile.name}
          initialText={newFile.text}
          onClose={() => setNewFile(undefined)}
          onProblem={setActed}
          onCreated={(hash, created, name) => {
            setNewFile(undefined);
            onImported();
            // Selected rather than merely made: the file a person just made is
            // what they are looking at, and the inspector is where they would
            // tag it.
            selection.click(hash);
            noteResult(
              created
                ? `Made ${name}`
                : newFile.text === ""
                  ? "Roost already holds an empty file — every empty file is the same one here"
                  : `${name} holds bytes the library already had`,
            );
          }}
        />
      )}

      <DropZone
        onDrop={dropped}
        captioning={showingPreview && captionable(paging.assets, focused)}
      />

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
        {...(confirming?.option === undefined
          ? {}
          : {
              option: {
                label: confirming.option.label,
                checked: optionOn,
                onChange: setOptionOn,
              },
            })}
        onConfirm={() => {
          confirming?.run(optionOn);
          setConfirming(undefined);
        }}
        onCancel={() => setConfirming(undefined)}
      />

      {/* Mounted only while it is open, so the name it starts with is the state
          it starts with rather than something to synchronise. */}
      {naming !== undefined && (
        <FolderDialog
          what={naming}
          onClose={() => setNaming(undefined)}
          onDone={(folder, name) => {
            setNaming(undefined);
            if (naming.kind === "create") {
              // A subfolder made inside a closed branch would be invisible, and
              // a dialog that appears to do nothing is the bug this avoids.
              if (naming.parent !== null) reveal(naming.parent);
              reveal(folder);
            }
            // Renaming reveals nothing. It used to reveal the folder it had
            // just renamed, which sprang the branch open under a gesture that
            // was about the name — seen in a real window on 2026-09-07.
            noteResult(naming.kind === "create" ? `Created ${name}` : `Renamed to ${name}`);
          }}
        />
      )}
      {/*
        Mounted only while it is open, so the survey it fetches is fetched once
        per opening rather than kept in step with a prop.
      */}
      {eagle !== undefined && (
        <EagleDialog
          path={eagle}
          onCancel={() => setEagle(undefined)}
          onImport={() => {
            setEagle(undefined);
            importing.startEagle(eagle);
          }}
        />
      )}
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
