import type { ImportProgress, WireImportReport, WireProblem } from "@roost/contract";
import { useCallback, useEffect, useState } from "react";
import { invoke, onEvent } from "../bridge.js";

/**
 * Running an import, and saying how far it has got.
 *
 * The progress is an **event**, not a poll: the engine is the only process that
 * knows, and a renderer asking "how far now?" would be asking the thread doing
 * the work. The report is the reply to the request that started it, so a run
 * that finishes while nobody is looking still has an answer.
 *
 * One run at a time. A second import while the first is going would interleave
 * two journals' worth of records with no way to tell whose progress is whose,
 * and the interface has one status bar.
 */

export interface Importing {
  readonly running: boolean;
  readonly progress: ImportProgress | undefined;
  /** The last run's report, until another starts. */
  readonly report: WireImportReport | undefined;
  readonly problem: WireProblem | undefined;
  /** Starts an import. Ignored while one is running. */
  readonly start: (paths: readonly string[]) => void;
  /** Puts the last report away. */
  readonly dismiss: () => void;
}

export function useImport(onFinished: () => void): Importing {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | undefined>();
  const [report, setReport] = useState<WireImportReport | undefined>();
  const [problem, setProblem] = useState<WireProblem | undefined>();

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "import:progress") setProgress(event);
      }),
    [],
  );

  const start = useCallback(
    (paths: readonly string[]) => {
      if (paths.length === 0) return;
      setRunning((already) => {
        if (already) return already;
        setProgress(undefined);
        setReport(undefined);
        setProblem(undefined);

        void (async () => {
          // Managed, and no tags: the mode belongs in a preference and the tags
          // in an import dialog, neither of which exists yet. `TODO.md` §M3.
          const outcome = await invoke({ type: "import:paths", paths, mode: "managed", tags: [] });
          setRunning(false);
          setProgress(undefined);
          if (outcome.ok) setReport(outcome.value);
          else setProblem(outcome.problem);
          // The counts, the sidebar, and the grid are all wrong now.
          onFinished();
        })();
        return true;
      });
    },
    [onFinished],
  );

  const dismiss = useCallback(() => {
    setReport(undefined);
    setProblem(undefined);
  }, []);

  return { running, progress, report, problem, start, dismiss };
}
