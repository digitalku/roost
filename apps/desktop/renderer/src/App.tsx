import type { LibraryStats, LibrarySummary, WireProblem, WireSidebar } from "@roost/contract";
import { LIBRARY_SUFFIX } from "@roost/contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { markFirstPaint } from "./bench/bench.js";
import { invoke, onEvent } from "./bridge.js";
import { Grid } from "./grid/Grid.js";
import type { GridMode } from "./grid/layout.js";
import { useAssetPages } from "./grid/paging.js";
import { SelectionStore } from "./grid/selection.js";
import { DropZone } from "./import/DropZone.js";
import { type Importing, useImport } from "./import/useImport.js";
import { Inspector } from "./inspector/Inspector.js";
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

  // Focus moved deliberately, in the frame after the form appears, rather than
  // with `autoFocus`: this form opens in response to a click, so putting the
  // caret in it is finishing what the click started.
  useEffect(() => {
    if (creating) nameField.current?.focus();
  }, [creating]);

  /**
   * The asset count as of the last read.
   *
   * A ref rather than reading it back out of `opened` inside a state updater:
   * an updater must be pure, and deciding whether to bump another piece of
   * state inside one is exactly the impurity React is entitled to run twice.
   */
  const lastCount = useRef<number | undefined>(undefined);

  const readStats = useCallback(async (summary: LibrarySummary, sameLibrary = false) => {
    const stats = await invoke({ type: "library:stats" });
    if (!stats.ok) return setProblem(stats.problem);

    // A different asset count means rows were added or removed — by an import
    // here, by another window, or by the CLI — and the grid's pages are then
    // wrong rather than merely stale. Anything that leaves the count alone (a
    // rating, a note, a tag) does not throw them away.
    const rowsChanged = !sameLibrary || lastCount.current !== stats.value.assets;
    lastCount.current = stats.value.assets;

    setProblem(undefined);
    setOpened({ summary, stats: stats.value });
    setRevision((n) => n + 1);
    if (rowsChanged) setGeneration((n) => n + 1);
  }, []);

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

  const openLibrary = async () => {
    setBusy(true);
    const chosen = await invoke({ type: "dialog:openLibrary" });
    if (!chosen.ok) {
      setBusy(false);
      return setProblem(chosen.problem);
    }
    // Cancelled: leave the screen exactly as it was.
    if (chosen.value === null) return setBusy(false);

    const outcome = await invoke({ type: "library:open", path: chosen.value });
    setBusy(false);
    if (!outcome.ok) {
      setOpened(undefined);
      return setProblem(outcome.problem);
    }
    await readStats(outcome.value);
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
  const [mode, setMode] = useState<GridMode>("masonry");
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
  const showing = problem ?? paging.problem;

  // Subscribed for the wake, not for the value: the count is read straight off
  // the store below, and a revision counter is what makes "deselect one, select
  // another" register as a change at all.
  useSyncExternalStore(selection.subscribeRevision, selection.revision);
  const count = selection.size;
  // The inspector follows focus, not selection: a `Shift`-click selects a run
  // and the panel shows the one the ring is on (`UI_SPEC.md` §6).
  const focused = selection.focused;
  const [previewing, setPreviewing] = useState(false);

  // The end of cold start: not when the window opened, not when the engine
  // replied, but when there is a grid with rows in it (`ROADMAP.md` M3).
  useEffect(() => {
    if (paging.assets.length > 0) markFirstPaint();
  }, [paging.assets.length]);

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
          <button
            type="button"
            data-active={mode === "masonry" || undefined}
            onClick={() => setMode("masonry")}
          >
            Masonry
          </button>
          <button
            type="button"
            data-active={mode === "uniform" || undefined}
            onClick={() => setMode("uniform")}
          >
            Uniform
          </button>
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
        {previewing && focused !== undefined ? (
          <PreviewPane hash={focused} onClose={() => setPreviewing(false)} onStep={step} />
        ) : paging.assets.length === 0 && paging.done ? (
          <p className="grid-empty">{query === "" ? EMPTY_LIBRARY : NOTHING_MATCHED}</p>
        ) : (
          <Grid
            assets={paging.assets}
            mode={mode}
            target={240}
            selection={selection}
            onMore={paging.more}
            onOpen={() => setPreviewing(true)}
          />
        )}
        <Inspector hash={focused} generation={revision} />
      </div>

      <DropZone onDrop={importing.start} />

      <footer className="status">
        {/* One text node, so what the status bar says is one readable string
            rather than four fragments a screen reader has to reassemble. */}
        <span>{summaryLine(query === "" ? opened.stats.assets : matches, count)}</span>
        <ImportStatus importing={importing} />
        <span className="path">{opened.summary.root}</span>
      </footer>
      {showing !== undefined && <Problem problem={showing} />}
    </div>
  );
}
