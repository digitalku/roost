import type { WireDeriveStatus } from "@roost/contract";
import { useCallback, useEffect, useState } from "react";
import { invoke, onEvent } from "./bridge.js";
import { counted } from "./format.js";

/**
 * What the derive queue is doing, in the status bar (`ROADMAP.md` M4).
 *
 * **Progress, and only progress** (ADR-0050): how much is left, with a × that
 * pauses it, or what a pause left, with Resume (ADR-0049). Why a particular
 * cell has no picture is said by the cell's badge and, when the file is opened,
 * by the file itself — in the inspector and in the preview, with what can be
 * done about it. This line used to count what failed and what waited on a
 * tool, and to open a list of them; the user found that was not the question
 * they had (*"pop up X could not be drawn tidak perlu"*, 2026-09-25).
 *
 * It says nothing at all when there is nothing to say. A library whose queue is
 * empty should not carry a status about a queue.
 */

/** How often the queue is re-read while it is working. */
const POLL_MS = 1500;

export function useDeriveStatus(revision: number): {
  readonly status: WireDeriveStatus | undefined;
  /** Stop working the queue until {@link resume} (ADR-0049). */
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
} {
  const [status, setStatus] = useState<WireDeriveStatus | undefined>();

  const read = useCallback(async () => {
    const outcome = await invoke({ type: "derive:status" });
    // A failure here is not worth a dialog: the queue is background work, and
    // the window carries on showing what it has.
    if (outcome.ok) setStatus(outcome.value);
  }, []);

  /*
   * `revision` is a trigger rather than a value the body reads: the queue
   * changes when the library does — an import fills it, a rebuild empties the
   * thumbnails it holds — so re-reading on the same signal the rest of the
   * window uses keeps them in step.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    void read();
  }, [read, revision]);

  // Progress arrives as an event, but the event carries a running count rather
  // than the queue's shape — how much is parked, and on what — so the event is
  // what schedules a re-read rather than what updates the numbers.
  useEffect(() => {
    let pending = false;
    const stop = onEvent((event) => {
      if (event.type !== "job:progress" || pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        void read();
      }, POLL_MS);
    });
    return stop;
  }, [read]);

  const pause = useCallback(async () => {
    const outcome = await invoke({ type: "derive:pause" });
    if (outcome.ok) setStatus(outcome.value);
  }, []);

  const resume = useCallback(async () => {
    const outcome = await invoke({ type: "derive:resume" });
    if (outcome.ok) setStatus(outcome.value);
  }, []);

  return { status, pause, resume };
}

/** What a paused queue has left: queued, and anything still finishing. */
export function derivesLeft(status: WireDeriveStatus | undefined): number {
  return status === undefined ? 0 : status.ready + status.running;
}

export interface DeriveStatusProps {
  readonly status: WireDeriveStatus | undefined;
  /** The × beside the running count, and Resume beside the paused one (ADR-0049). */
  readonly onPause?: () => void;
  readonly onResume?: () => void;
}

export function DeriveStatus({
  status,
  onPause,
  onResume,
}: DeriveStatusProps): React.JSX.Element | null {
  if (status === undefined) return null;

  const working = status.ready + status.running;
  if (working === 0) return null;
  return status.paused ? (
    <>
      <span className="status-job">Paused · {counted(working)} left</span>
      {onResume !== undefined && (
        <button type="button" className="status-job status-job-action" onClick={onResume}>
          Resume
        </button>
      )}
    </>
  ) : (
    <>
      <span className="status-job">Deriving… {counted(working)} to go</span>
      {/* A button of its own rather than the line: the line was never a
            control while work is going, and a click that stopped the work would
            be a pause nobody meant to make. */}
      {onPause !== undefined && (
        <button
          type="button"
          className="status-job status-job-action"
          aria-label="Pause deriving"
          title="Pause — what is left waits until Resume. Files you open are still drawn."
          onClick={onPause}
        >
          ×
        </button>
      )}
    </>
  );
}
