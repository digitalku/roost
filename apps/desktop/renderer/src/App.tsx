import type { LibraryStats, LibrarySummary, WireProblem } from "@roost/contract";
import { LIBRARY_SUFFIX } from "@roost/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, onEvent } from "./bridge.js";

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

  // Focus moved deliberately, in the frame after the form appears, rather than
  // with `autoFocus`: this form opens in response to a click, so putting the
  // caret in it is finishing what the click started.
  useEffect(() => {
    if (creating) nameField.current?.focus();
  }, [creating]);

  const readStats = useCallback(async (summary: LibrarySummary) => {
    const stats = await invoke({ type: "library:stats" });
    if (!stats.ok) return setProblem(stats.problem);
    setProblem(undefined);
    setOpened({ summary, stats: stats.value });
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
          void readStats(opened.summary);
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
      <Frame summary={opened.summary}>
        <section className="panel">
          <h1>{opened.summary.name}</h1>
          <Counts stats={opened.stats} />
          <button type="button" onClick={() => void close()}>
            Close library
          </button>
          {problem !== undefined && <Problem problem={problem} />}
        </section>
      </Frame>
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

/** The counts a library reports, in the order `roost stats` prints them. */
function Counts({ stats }: { readonly stats: LibraryStats }): React.JSX.Element {
  const rows: readonly (readonly [string, number])[] = [
    ["Assets", stats.assets],
    ["Managed", stats.managed],
    ["Referenced", stats.referenced],
    ["Tags", stats.tags],
    ["Folders", stats.folders],
    ["Smart folders", stats.smartFolders],
    ["Rated", stats.rated],
    ["Favourites", stats.favorites],
    ["Thumbnails", stats.thumbnails],
  ];

  return (
    <dl className="counts">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd>{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}
