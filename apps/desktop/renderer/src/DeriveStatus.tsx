import type { WireDeriveStatus } from "@roost/contract";
import { useCallback, useEffect, useState } from "react";
import { invoke, onEvent } from "./bridge.js";
import { DeriveFailures } from "./DeriveFailures.js";
import { CAPABILITY_OF_REASON } from "./deriveReason.js";

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

  if (status.failed > 0) {
    return (
      <Stalled
        state="failed"
        label={`${status.failed.toLocaleString()} could not be drawn`}
        capabilities={status.capabilities}
        onRetry={onRetry}
      />
    );
  }

  if (status.blocked > 0) {
    // Something parked on a tool this machine does not have is the one case a
    // person can act on, so it is what the line says when there is one — the
    // capability's own sentence rather than a count. Everything else parked is
    // a format nothing here draws, and that is a number.
    const missing = status.reasons.find(
      (reason) => CAPABILITY_OF_REASON[reason.reason] !== undefined,
    );
    const capability = status.capabilities.find(
      (entry) =>
        !entry.available &&
        entry.name === (missing === undefined ? "" : CAPABILITY_OF_REASON[missing.reason]),
    );

    return (
      <Stalled
        state="blocked"
        label={capability?.detail ?? `${status.blocked.toLocaleString()} without a preview`}
        capabilities={status.capabilities}
        onRetry={onRetry}
      />
    );
  }

  return null;
}

/**
 * Work with no picture, and the list that says which files and why.
 *
 * It **opens the list** rather than acting (`UI_SPEC.md` §3.13). A button that
 * only retried was answering a question nobody had asked: a person looking at
 * "36 could not be drawn" wants to know which thirty-six and why, and pressing
 * Try again on a folder of damaged files produces the same thirty-six a minute
 * later with nothing learned. The same is true one degree further along for
 * parked work — "19 without a preview" is a number whose whole content is the
 * reasons behind it. Acting is still one click away, inside the dialog, next to
 * the thing it would act on.
 */
function Stalled({
  state,
  label,
  capabilities,
  onRetry,
}: {
  readonly state: "failed" | "blocked";
  readonly label: string;
  readonly capabilities: WireDeriveStatus["capabilities"];
  readonly onRetry: (reason?: string) => void;
}): React.JSX.Element {
  const [showing, setShowing] = useState(false);

  return (
    <>
      <button
        type="button"
        className="status-job"
        onClick={() => setShowing(true)}
        title={state === "failed" ? "See what failed, and why" : "See what has no preview, and why"}
      >
        {label}
      </button>
      {showing && (
        <DeriveFailures
          state={state}
          capabilities={capabilities}
          onRetry={onRetry}
          onClose={() => setShowing(false)}
        />
      )}
    </>
  );
}
