import type { WireDeriveStatus } from "@roost/contract";
import { useCallback, useEffect, useState } from "react";
import { invoke, onEvent } from "./bridge.js";

/**
 * What the derive queue is doing, in the status bar (`ROADMAP.md` M4).
 *
 * An empty cell in the grid is not self-explanatory: a thumbnail that has not
 * been made yet, a format nothing in this build draws, and a video waiting for
 * an ffmpeg nobody installed all look identical. This is the line that tells
 * them apart, and the button that acts on the one the user can fix.
 *
 * It says nothing at all when there is nothing to say. A library whose queue is
 * empty should not carry a status about a queue.
 */

/** How often the queue is re-read while it is working. */
const POLL_MS = 1500;

export function useDeriveStatus(revision: number): {
  readonly status: WireDeriveStatus | undefined;
  readonly retry: (reason?: string) => Promise<void>;
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

  const retry = useCallback(async (reason?: string) => {
    const outcome = await invoke({ type: "derive:retry", reason: reason ?? null });
    if (outcome.ok) setStatus(outcome.value);
  }, []);

  return { status, retry };
}

export interface DeriveStatusProps {
  readonly status: WireDeriveStatus | undefined;
  readonly onRetry: (reason?: string) => void;
}

export function DeriveStatus({ status, onRetry }: DeriveStatusProps): React.JSX.Element | null {
  if (status === undefined) return null;

  const working = status.ready + status.running;
  if (working > 0) {
    return <span className="status-job">Deriving… {working.toLocaleString()} to go</span>;
  }

  // Something is parked on a tool this machine does not have. That is the one
  // case the user can act on, so it is the one that gets a button.
  const missing = status.reasons.find((reason) => reason.reason.startsWith("missing:"));
  const capability = status.capabilities.find((entry) => !entry.available);
  if (missing !== undefined && capability !== undefined) {
    return (
      <button
        type="button"
        className="status-job"
        onClick={() => onRetry(missing.reason)}
        title={`${missing.count.toLocaleString()} waiting · ${missing.reason}`}
      >
        {capability.detail} · Try again
      </button>
    );
  }

  if (status.failed > 0) {
    return (
      <button type="button" className="status-job" onClick={() => onRetry()}>
        {status.failed.toLocaleString()} could not be drawn · Try again
      </button>
    );
  }

  // Parked on a format nothing here draws — a zip, a BMP. Said once, quietly,
  // and with no button: there is nothing to try again.
  if (status.blocked > 0) {
    return (
      <span className="status-job" title={status.reasons.map((r) => r.reason).join(", ")}>
        {status.blocked.toLocaleString()} without a preview
      </span>
    );
  }

  return null;
}
