import type { WireDeriveStatus } from "@roost/contract";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useState } from "react";
import { invoke, onEvent } from "./bridge.js";
import { counted } from "./format.js";

/**
 * What the derive queue is doing, in the status bar (`ROADMAP.md` M4).
 *
 * **A count, and only a count** (ADR-0050, ADR-0065): how many files have no
 * picture yet, which says why when pressed, and how many a rebuild left to read.
 * Why a particular
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

  return { status };
}

export interface DeriveStatusProps {
  readonly status: WireDeriveStatus | undefined;
}

export function DeriveStatus({ status }: DeriveStatusProps): React.JSX.Element | null {
  if (status === undefined) return null;

  const waiting = status.ready + status.running;
  return (
    <>
      {status.checking > 0 && (
        <span className="status-job">Checking files… {counted(status.checking)} to go</span>
      )}
      {waiting > 0 && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="status-job status-job-info">
              {counted(waiting)} {waiting === 1 ? "thumbnail" : "thumbnails"} not drawn yet
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="menu derive-note"
              side="top"
              align="end"
              collisionPadding={8}
            >
              <p>
                Thumbnails are drawn a little at a time as you use Roost: what is on screen, and
                what you open.
              </p>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </>
  );
}
