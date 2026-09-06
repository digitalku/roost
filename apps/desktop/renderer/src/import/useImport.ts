import type {
  ImportProgress,
  StorageMode,
  WireEagleReport,
  WireImportReport,
  WireProblem,
} from "@roost/contract";
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

/**
 * What a finished run has to say.
 *
 * Two shapes rather than one widened to fit both: an Eagle import counts
 * folders, tags and comments, and a path import counts none of those. Widening
 * would have given every field of each to the other as a zero, and a status bar
 * saying "0 folders" after importing a directory is a number that means nothing
 * was asked.
 */
export type ImportOutcome =
  | { readonly kind: "paths"; readonly report: WireImportReport }
  | { readonly kind: "eagle"; readonly report: WireEagleReport };

export interface Importing {
  readonly running: boolean;
  readonly progress: ImportProgress | undefined;
  /** The last run's outcome, until another starts. */
  readonly outcome: ImportOutcome | undefined;
  readonly problem: WireProblem | undefined;
  /** Starts an import. Ignored while one is running. */
  readonly start: (paths: readonly string[]) => void;
  /** Imports an Eagle library, whole (ADR-0032). Ignored while one is running. */
  readonly startEagle: (path: string, mode?: StorageMode) => void;
  /** Puts the last outcome away. */
  readonly dismiss: () => void;
}

export function useImport(onFinished: () => void): Importing {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | undefined>();
  const [outcome, setOutcome] = useState<ImportOutcome | undefined>();
  const [problem, setProblem] = useState<WireProblem | undefined>();

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "import:progress") setProgress(event);
      }),
    [],
  );

  /**
   * The half both starts share: one run at a time, and the reply ends it.
   *
   * The guard is inside `setRunning` rather than around it because two clicks
   * in one tick would both read a stale `false` from the closure.
   */
  const run = useCallback(
    (request: () => Promise<ImportOutcome | WireProblem>) => {
      setRunning((already) => {
        if (already) return already;
        setProgress(undefined);
        setOutcome(undefined);
        setProblem(undefined);

        void (async () => {
          const answer = await request();
          setRunning(false);
          setProgress(undefined);
          if ("kind" in answer) setOutcome(answer);
          else setProblem(answer);
          // The counts, the sidebar, and the grid are all wrong now.
          onFinished();
        })();
        return true;
      });
    },
    [onFinished],
  );

  const start = useCallback(
    (paths: readonly string[]) => {
      if (paths.length === 0) return;
      run(async () => {
        // Managed, and no tags: the mode belongs in a preference and the tags
        // in an import dialog, neither of which exists yet. `TODO.md` §M3.
        const answer = await invoke({ type: "import:paths", paths, mode: "managed", tags: [] });
        return answer.ok ? { kind: "paths", report: answer.value } : answer.problem;
      });
    },
    [run],
  );

  const startEagle = useCallback(
    (path: string, mode: StorageMode = "managed") => {
      if (path.trim() === "") return;
      run(async () => {
        const answer = await invoke({ type: "eagle:import", path, mode });
        return answer.ok ? { kind: "eagle", report: answer.value } : answer.problem;
      });
    },
    [run],
  );

  const dismiss = useCallback(() => {
    setOutcome(undefined);
    setProblem(undefined);
  }, []);

  return { running, progress, outcome, problem, start, startEagle, dismiss };
}
