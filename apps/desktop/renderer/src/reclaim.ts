import type { WireProblem } from "@roost/contract";
import { useMemo } from "react";
import { invoke } from "./bridge.js";
import { bytes } from "./format.js";
import type { ConfirmRequest } from "./grid/trash-actions.js";

/**
 * Reclaiming the space nothing references (ADR-0031).
 *
 * A permanent delete now takes its own bytes with it, so this is for objects
 * orphaned by everything *else*: a library carried over from an older build, an
 * import interrupted between the file and the row, a crash between the index
 * and the store. It is the window's door to what `roost doctor --reclaim` does,
 * and it is here rather than in the trash because the trash is not where
 * orphans come from.
 *
 * **Two requests, and the second checks again.** The first is what the
 * confirmation is about — nobody should approve a deletion whose size they have
 * not been shown — and the second re-runs the check before deleting anything,
 * because the numbers on screen are a screenful old and this deletes files.
 */
export interface ReclaimOptions {
  readonly onNote: (line: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
  readonly onConfirm: (request: ConfirmRequest) => void;
}

export function useReclaim({ onNote, onProblem, onConfirm }: ReclaimOptions): () => void {
  return useMemo(
    () => () => {
      void invoke({ type: "library:reclaimable" }).then((outcome) => {
        if (!outcome.ok) return onProblem(outcome.problem);
        const { objects, bytes: size, blocked } = outcome.value;

        // Refused for the same reason the CLI refuses: an orphan is only an
        // orphan relative to the index, so a disagreeing index is not a basis
        // for deleting anything. The answer is always a rebuild.
        if (blocked !== null) {
          return onNote(`Cannot reclaim: ${blocked}. Rebuild the library first`);
        }
        if (objects === 0)
          return onNote("Nothing to reclaim — every file here belongs to an asset");

        onConfirm({
          title: `Reclaim ${bytes(size)}?`,
          body: `${objects.toLocaleString()} ${objects === 1 ? "file" : "files"} under originals/ belong to no asset in this library. Deleting them frees ${bytes(size)} and cannot be undone: an orphan is not in the journal, so no rebuild brings it back.`,
          confirmLabel: "Reclaim",
          run: () => {
            void invoke({ type: "library:reclaim" }).then((done) => {
              if (!done.ok) return onProblem(done.problem);
              onNote(`Reclaimed ${bytes(done.value.bytes)}`);
            });
          },
        });
      });
    },
    [onNote, onProblem, onConfirm],
  );
}
