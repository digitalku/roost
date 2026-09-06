import type { WireProblem } from "@roost/contract";
import { useMemo } from "react";
import { invoke } from "../bridge.js";
import { bytes } from "../format.js";

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
  /**
   * The assets acted on are no longer where they were.
   *
   * Every action here takes its assets out of the view they were selected in —
   * trashing and deleting out of the library, restoring out of the Trash — so
   * the selection that named them is a selection of things nobody can see. Left
   * alone it says "1 selected" over a grid with nothing highlighted, keeps the
   * inspector editing a trashed asset, and leaves the roving ring with nowhere
   * to go. Found by driving a real window on 2026-09-01; no component test
   * could see it, because none of them owns a selection *and* a grid.
   *
   * Deliberately not `onNote`: exporting says something too, and an export
   * takes nothing out of the view.
   *
   * **Called before `onNote`, always.** The window clears its status line when
   * the selection moves away from the one the line was written against, so a
   * note written before the clear is wiped by it. Saying it afterwards stamps
   * the note against the selection that will still be there to read it.
   */
  readonly onGone: () => void;
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
  onGone,
}: TrashActionsOptions): TrashActions {
  return useMemo(() => {
    const count = hashes.length;

    const trash = (): void => {
      void invoke({ type: "assets:trash", hashes }).then((outcome) => {
        if (!outcome.ok) return onProblem(outcome.problem);
        onGone();
        onNote(`Moved ${assets(count)} to the trash`);
      });
    };

    const restore = (): void => {
      void invoke({ type: "assets:restore", hashes }).then((outcome) => {
        if (!outcome.ok) return onProblem(outcome.problem);
        onGone();
        onNote(`Restored ${assets(count)}`);
      });
    };

    const deletePermanently = (): void => {
      if (count === 0) return;
      onConfirm({
        title: count === 1 ? "Delete this asset?" : `Delete ${count} assets?`,
        body: `${capitalise(assets(count))} will be removed from the library, and the files they own will be deleted from it. Tags, ratings, notes, and folder memberships go with them, and this cannot be undone.`,
        confirmLabel: "Delete",
        run: () => {
          void invoke({ type: "assets:remove", hashes }).then((outcome) => {
            if (!outcome.ok) return onProblem(outcome.problem);
            onGone();
            onNote(deleted(outcome.value.assets, outcome.value.bytes));
          });
        },
      });
    };

    const emptyTrash = (): void => {
      onConfirm({
        title: "Empty the trash?",
        body: "Everything in the trash will be removed from the library, and the files it owns will be deleted from it. Tags, ratings, notes, and folder memberships go with it, and this cannot be undone.",
        confirmLabel: "Empty trash",
        run: () => {
          void invoke({ type: "assets:emptyTrash" }).then((outcome) => {
            if (!outcome.ok) return onProblem(outcome.problem);
            onGone();
            onNote(deleted(outcome.value.assets, outcome.value.bytes));
          });
        },
      });
    };

    return { trash, restore, deletePermanently, emptyTrash };
  }, [hashes, onNote, onProblem, onConfirm, onGone]);
}

/**
 * What a permanent delete did, in one line.
 *
 * The freed bytes are said because they are the half a person came for
 * (ADR-0031), and **zero is said too**: a selection of referenced assets frees
 * nothing, and a line that mentioned bytes only when there were some would make
 * that case look like a failure to report rather than a fact about the assets.
 */
function deleted(count: number, freed: number): string {
  return freed === 0
    ? `Deleted ${assets(count)}, freeing nothing — none of them was stored here`
    : `Deleted ${assets(count)}, freeing ${bytes(freed)}`;
}

/** "1 asset" or "12 assets" — the CLI's phrasing, so the two frontends agree. */
export function assets(count: number): string {
  return count === 1 ? "1 asset" : `${count.toLocaleString()} assets`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
