import type {
  ImportProgress,
  Take,
  WireEagleReport,
  WireFiled,
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

/**
 * The files a finished run found were already here (ADR-0037 §3).
 *
 * Raised after the run rather than before it, because deduplication here is
 * structural: a duplicate is discovered by hashing the incoming file. It costs
 * nothing to wait — for a duplicate, an import writes nothing at all.
 */
export interface DuplicateQuestion {
  readonly total: number;
  /** The first few by name. The rest are counted, never listed. */
  readonly names: readonly string[];
  /**
   * Whether they came from directories brought across as folders, and so each
   * has a folder of its own to go to (ADR-0058 §3.4).
   */
  readonly placed: boolean;
}

export interface Importing {
  readonly running: boolean;
  readonly progress: ImportProgress | undefined;
  /** The last run's outcome, until another starts. */
  readonly outcome: ImportOutcome | undefined;
  readonly problem: WireProblem | undefined;
  /** Starts an import. Ignored while one is running. */
  readonly start: (paths: readonly string[]) => void;
  /** Imports an Eagle library, whole (ADR-0032). Ignored while one is running. */
  readonly startEagle: (path: string, mode?: Take) => void;
  /** Puts the last outcome away. */
  readonly dismiss: () => void;
  /**
   * Stops the run (ADR-0055 §3.3). What has arrived stays; the reply to the
   * request that started it arrives a moment later with `cancelled` set.
   */
  readonly cancel: () => void;
  /** × was pressed, and the engine is committing the batch in hand. */
  readonly stopping: boolean;
  /** The duplicates a finished run is waiting for an answer about. */
  readonly duplicates: DuplicateQuestion | undefined;
  /**
   * Puts the last run's duplicates in `folder` as well, or each in the folder
   * its directory became for `null`, and answers the question.
   *
   * An add, never a move: an asset belongs to as many folders as it was put in,
   * so nothing is taken out of anywhere it already was.
   */
  readonly fileDuplicates: (folder: number | null) => Promise<WireFiled | undefined>;
  /** Answers the question by leaving them alone, which is what the run did. */
  readonly ignoreDuplicates: () => void;
}

export function useImport(onFinished: () => void, folder: number | null): Importing {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | undefined>();
  const [outcome, setOutcome] = useState<ImportOutcome | undefined>();
  const [problem, setProblem] = useState<WireProblem | undefined>();
  const [duplicates, setDuplicates] = useState<DuplicateQuestion | undefined>();
  const [stopping, setStopping] = useState(false);

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
        setStopping(false);
        // The previous run's question goes with the previous run: the list it
        // was about belongs to that run, and the engine has already replaced it.
        setDuplicates(undefined);

        void (async () => {
          const answer = await request();
          setRunning(false);
          setProgress(undefined);
          setStopping(false);
          if ("kind" in answer) setOutcome(answer);
          else setProblem(answer);
          // Only a path import asks. An Eagle library brings its own folders,
          // and a duplicate in one is an item that found its bytes already
          // here — not a file somebody just chose (ADR-0032 §3).
          if ("kind" in answer && answer.kind === "paths" && answer.report.duplicates > 0) {
            setDuplicates({
              total: answer.report.duplicates,
              names: answer.report.duplicateNames,
              placed: answer.report.duplicatesPlaced,
            });
          }
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
        // Managed, and no tags: the take belongs in a preference and the tags
        // in an import dialog, neither of which exists yet. `TODO.md` §M3.
        //
        // The folder is the one the window was showing when the run started
        // (ADR-0037 §2) — read here, not when the reply comes back, so an
        // import of forty thousand files does not follow the user around.
        const answer = await invoke({
          type: "import:paths",
          paths,
          take: "copy",
          tags: [],
          folder,
        });
        return answer.ok ? { kind: "paths", report: answer.value } : answer.problem;
      });
    },
    [run, folder],
  );

  const startEagle = useCallback(
    (path: string, take: Take = "copy") => {
      if (path.trim() === "") return;
      run(async () => {
        const answer = await invoke({ type: "eagle:import", path, take });
        return answer.ok ? { kind: "eagle", report: answer.value } : answer.problem;
      });
    },
    [run],
  );

  const dismiss = useCallback(() => {
    setOutcome(undefined);
    setProblem(undefined);
  }, []);

  const fileDuplicates = useCallback(async (into: number | null) => {
    // Put away first: the answer has been given, and the engine's reply is
    // about how it went rather than whether to ask again.
    setDuplicates(undefined);
    const answer = await invoke({ type: "import:fileDuplicates", folder: into });
    if (answer.ok) return answer.value;
    setProblem(answer.problem);
    return undefined;
  }, []);

  const ignoreDuplicates = useCallback(() => setDuplicates(undefined), []);

  const cancel = useCallback(() => {
    setStopping(true);
    void invoke({ type: "import:cancel" });
  }, []);

  return {
    running,
    progress,
    outcome,
    problem,
    start,
    startEagle,
    dismiss,
    cancel,
    stopping,
    duplicates,
    fileDuplicates,
    ignoreDuplicates,
  };
}
