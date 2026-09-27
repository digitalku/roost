import type { Take, WireProblem, WireRecentLibrary, WireTransferProgress } from "@roost/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, onEvent } from "../bridge.js";
import { bytes, counted } from "../format.js";
import { transferLine } from "./TransferMenu.js";
import { assets } from "./trash-actions.js";

/**
 * A move or copy into another library, while it runs (ADR-0054 §3.9).
 *
 * Held by the window rather than by the menu that started it. A transfer of a
 * few videos onto a hard disk outlives the menu by minutes, and the status bar
 * is where it says how far it has got and where the × that stops it is.
 */

/** What was asked for, which the progress events do not repeat. */
export interface TransferRun {
  readonly name: string;
  readonly take: Take;
  readonly ids: readonly string[];
}

export interface Transferring {
  readonly running: TransferRun | undefined;
  readonly progress: WireTransferProgress | undefined;
  /** × was pressed, and the engine is finishing the file in hand. */
  readonly stopping: boolean;
  readonly start: (ids: readonly string[], target: WireRecentLibrary, take: Take) => void;
  readonly cancel: () => void;
}

export interface TransferOptions {
  readonly onNote: (line: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
  /**
   * Some of these left the library, so the selection should stop naming them.
   *
   * Only these, and not the whole selection: minutes may have passed, and what
   * is selected now may be something else entirely.
   */
  readonly onLeft: (ids: readonly string[]) => void;
}

export function useTransfer({ onNote, onProblem, onLeft }: TransferOptions): Transferring {
  const [running, setRunning] = useState<TransferRun | undefined>();
  const [progress, setProgress] = useState<WireTransferProgress | undefined>();
  const [stopping, setStopping] = useState(false);
  // Read by `start`, which must refuse a second run in the same tick as the
  // first — before a render has had the chance to disable the menu.
  const busy = useRef(false);

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "transfer:progress") setProgress(event);
      }),
    [],
  );

  const start = useCallback(
    (ids: readonly string[], target: WireRecentLibrary, take: Take) => {
      if (busy.current || ids.length === 0) return;
      busy.current = true;
      setRunning({ name: target.name, take, ids });
      setProgress(undefined);
      setStopping(false);
      void invoke({ type: "assets:transfer", ids, target: target.root, take }).then((outcome) => {
        busy.current = false;
        setRunning(undefined);
        setProgress(undefined);
        setStopping(false);
        if (!outcome.ok) return onProblem(outcome.problem);
        if (outcome.value.removed > 0) onLeft(ids);
        onNote(transferLine(outcome.value, take, target.name));
      });
    },
    [onNote, onProblem, onLeft],
  );

  const cancel = useCallback(() => {
    if (!busy.current) return;
    setStopping(true);
    void invoke({ type: "assets:transferCancel" });
  }, []);

  return { running, progress, stopping, start, cancel };
}

/** How far through, as a whole percentage: by bytes, or by assets where there are none. */
export function percentOf(progress: WireTransferProgress | undefined): number {
  if (progress === undefined) return 0;
  const fraction =
    progress.bytesTotal > 0
      ? progress.bytesDone / progress.bytesTotal
      : progress.total > 0
        ? progress.done / progress.total
        : 0;
  return Math.min(100, Math.floor(fraction * 100));
}

export function TransferStatus({
  transferring,
}: {
  readonly transferring: Transferring;
}): React.JSX.Element | null {
  const { running, progress, stopping, cancel } = transferring;
  if (running === undefined) return null;

  const verb = running.take === "move" ? "Moving" : "Copying";
  const percent = percentOf(progress);
  const said = stopping
    ? `Stopping… ${running.take === "move" ? "what has arrived is moved" : "what has arrived stays copied"}`
    : progress === undefined
      ? `${verb} ${assets(running.ids.length)} to ${running.name}…`
      : [
          `${verb} to ${running.name}… ${percent}%`,
          ...(progress.bytesTotal > 0
            ? [`${bytes(progress.bytesDone)} of ${bytes(progress.bytesTotal)}`]
            : []),
          `${counted(progress.done)} of ${counted(progress.total)}`,
        ].join(" · ");

  return (
    <>
      <span className="status-job status-transfer">
        {/* Drawn as well as said: a percentage that moves by one every few
            seconds is easy to miss, and a bar is not. */}
        <span
          className="status-meter"
          role="progressbar"
          aria-label={`${verb} to ${running.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className="status-meter-fill" style={{ width: `${percent}%` }} />
        </span>
        {said}
      </span>
      {!stopping && (
        <button
          type="button"
          className="status-job status-job-action"
          aria-label={`Stop ${verb.toLowerCase()}`}
          title="Stop — what has arrived stays there, and the rest stays here."
          onClick={cancel}
        >
          ×
        </button>
      )}
    </>
  );
}
