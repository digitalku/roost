import type { LibraryStats, LibrarySummary, WireProblem } from "@roost/contract";
import { useCallback, useEffect, useState } from "react";
import { invoke, onEvent } from "./bridge.js";

/**
 * The window, at the point where it can open a library and say what is in it.
 *
 * Deliberately small: the grid, the sidebar, and the inspector are the rest of
 * M3, and each arrives with its own contract members. What this proves is the
 * whole path — renderer to preload to main to engine and back — with the
 * sandbox on.
 */

interface Opened {
  readonly summary: LibrarySummary;
  readonly stats: LibraryStats;
}

export function App(): React.JSX.Element {
  const [opened, setOpened] = useState<Opened | undefined>();
  const [problem, setProblem] = useState<WireProblem | undefined>();
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");

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

  const act = async (request: { type: "library:open" | "library:create" }) => {
    setBusy(true);
    const outcome =
      request.type === "library:open"
        ? await invoke({ type: "library:open", path })
        : await invoke({ type: "library:create", path, name: "" });
    setBusy(false);

    if (!outcome.ok) {
      setOpened(undefined);
      return setProblem(outcome.problem);
    }
    await readStats(outcome.value);
  };

  const close = async () => {
    await invoke({ type: "library:close" });
    setOpened(undefined);
    setProblem(undefined);
  };

  return (
    <div className="app">
      {opened === undefined ? (
        <section className="panel">
          <h1>Open a library</h1>
          <p>
            A Roost library is a directory holding <code>library.json</code>, an append-only
            journal, and the assets themselves. Nothing outside it is ever written to.
          </p>
          <div className="field">
            <input
              aria-label="Library path"
              placeholder="/home/you/Pictures/Roost"
              spellCheck={false}
              value={path}
              onChange={(changed) => setPath(changed.target.value)}
            />
            <button
              type="button"
              data-variant="primary"
              disabled={busy || path.trim() === ""}
              onClick={() => void act({ type: "library:open" })}
            >
              Open
            </button>
            <button
              type="button"
              disabled={busy || path.trim() === ""}
              onClick={() => void act({ type: "library:create" })}
            >
              Create
            </button>
          </div>
          {problem !== undefined && <Problem problem={problem} />}
        </section>
      ) : (
        <section className="panel">
          <h1>{opened.summary.name}</h1>
          <Counts stats={opened.stats} />
          <button type="button" onClick={() => void close()}>
            Close library
          </button>
          {problem !== undefined && <Problem problem={problem} />}
        </section>
      )}

      <footer className="status">
        <span>
          {opened === undefined ? "No library open" : `schema ${opened.summary.schemaVersion}`}
        </span>
        <span className="path">{opened?.summary.root ?? ""}</span>
      </footer>
    </div>
  );
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
