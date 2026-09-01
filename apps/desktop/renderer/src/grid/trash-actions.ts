import type { WireProblem } from "@roost/contract";
import { useMemo } from "react";
import { invoke } from "../bridge.js";

/**
 * Trashing, restoring, and deleting a selection (ADR-0022).
 *
 * A hook rather than four functions inside the context menu, because `Delete`
 * on the keyboard has to do exactly what the menu item does — including the
 * confirmation on the irreversible ones. Two copies of that rule is how a
 * keyboard shortcut comes to skip a dialog the menu asks for.
 *
 * The confirmation is *requested*, not drawn: this file knows which actions
 * cannot be undone, and the window owns the one dialog.
 */

/** An action that needs a yes before it runs. */
export interface ConfirmRequest {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly run: () => void;
}

export interface TrashActionsOptions {
  /** The selection to act on. */
  readonly hashes: readonly string[];
  /** Something happened and the status bar should say so. */
  readonly onNote: (line: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
  readonly onConfirm: (request: ConfirmRequest) => void;
}

export interface TrashActions {
  /** Reversible, so it asks nothing. */
  readonly trash: () => void;
  readonly restore: () => void;
  /** Both of these confirm first: neither can be undone. */
  readonly deletePermanently: () => void;
  readonly emptyTrash: () => void;
}

export function useTrashActions({
  hashes,
  onNote,
  onProblem,
  onConfirm,
}: TrashActionsOptions): TrashActions {
  return useMemo(() => {
    const count = hashes.length;

    const trash = (): void => {
      void invoke({ type: "assets:trash", hashes }).then((outcome) => {
        if (outcome.ok) onNote(`Moved ${assets(count)} to the trash`);
        else onProblem(outcome.problem);
      });
    };

    const restore = (): void => {
      void invoke({ type: "assets:restore", hashes }).then((outcome) => {
        if (outcome.ok) onNote(`Restored ${assets(count)}`);
        else onProblem(outcome.problem);
      });
    };

    const deletePermanently = (): void => {
      if (count === 0) return;
      onConfirm({
        title: count === 1 ? "Delete this asset?" : `Delete ${count} assets?`,
        body: `${capitalise(assets(count))} will be removed from the library. Tags, ratings, notes, and folder memberships go with them, and this cannot be undone.`,
        confirmLabel: "Delete",
        run: () => {
          void invoke({ type: "assets:remove", hashes }).then((outcome) => {
            if (outcome.ok) onNote(`Deleted ${assets(count)}`);
            else onProblem(outcome.problem);
          });
        },
      });
    };

    const emptyTrash = (): void => {
      onConfirm({
        title: "Empty the trash?",
        body: "Everything in the trash will be removed from the library. Tags, ratings, notes, and folder memberships go with it, and this cannot be undone.",
        confirmLabel: "Empty trash",
        run: () => {
          void invoke({ type: "assets:emptyTrash" }).then((outcome) => {
            if (outcome.ok) onNote(`Deleted ${assets(outcome.value)}`);
            else onProblem(outcome.problem);
          });
        },
      });
    };

    return { trash, restore, deletePermanently, emptyTrash };
  }, [hashes, onNote, onProblem, onConfirm]);
}

/** "1 asset" or "12 assets" — the CLI's phrasing, so the two frontends agree. */
export function assets(count: number): string {
  return count === 1 ? "1 asset" : `${count.toLocaleString()} assets`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
