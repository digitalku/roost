import type { WireProblem } from "@roost/contract";
import { useMemo } from "react";
import { invoke } from "../bridge.js";
import { bytes, counted } from "../format.js";

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
  /**
   * A second question, asked in the same dialog (ADR-0033).
   *
   * Not a second confirmation: it changes *what* the action does rather than
   * whether it happens. Its answer reaches `run`, so nothing here has to hold
   * a checkbox's state — the dialog owns it and hands it over on the way out.
   */
  readonly option?: { readonly label: string };
  readonly run: (option: boolean) => void;
  /**
   * What declining puts back, for a request made on behalf of something still
   * on screen — a field holding the text that was about to be written
   * (ADR-0048). Harmless if it also runs after a confirm, and it may: the
   * dialog closes itself either way.
   */
  readonly onCancel?: () => void;
}

export interface TrashActionsOptions {
  /** The selection to act on. */
  readonly ids: readonly string[];
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
   *
   * `ids` names what left, so the window can take those rows out and leave
   * the rest where they are (reported 2026-10-05: the grid went back to the
   * top). Absent when the trash was emptied, which takes everything in view.
   */
  readonly onGone: (ids?: readonly string[]) => void;
  /**
   * The library's counts are about to move, and by this much, because of
   * what this window is doing.
   *
   * Said **before** the request, because the engine announces the change
   * before it answers. The window uses it to recognise its own change when the
   * counts are re-read, and to keep its pages rather than fetch them again from
   * the top. A guess that turns out wrong costs only that re-fetch.
   */
  readonly onLeaving?: (change: RowChange) => void;
}

/** How far an action moves the two counts the grid's pages depend on. */
export interface RowChange {
  readonly assets: number;
  readonly trashed: number;
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
  ids,
  onNote,
  onProblem,
  onConfirm,
  onGone,
  onLeaving,
}: TrashActionsOptions): TrashActions {
  return useMemo(() => {
    const count = ids.length;

    /**
     * Tells the window what is about to move, and takes it back if the engine
     * refuses: a refused request moves nothing, and a window still expecting
     * the change would mistake the next real one for its own.
     */
    const expecting = (change: RowChange) => {
      onLeaving?.(change);
      return (problem: WireProblem): void => {
        onLeaving?.({ assets: -change.assets, trashed: -change.trashed });
        onProblem(problem);
      };
    };

    const trash = (): void => {
      const refused = expecting({ assets: 0, trashed: count });
      void invoke({ type: "assets:trash", ids }).then((outcome) => {
        if (!outcome.ok) return refused(outcome.problem);
        onGone(ids);
        onNote(`Moved ${assets(count)} to the trash`);
      });
    };

    const restore = (): void => {
      const refused = expecting({ assets: 0, trashed: -count });
      void invoke({ type: "assets:restore", ids }).then((outcome) => {
        if (!outcome.ok) return refused(outcome.problem);
        onGone(ids);
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
          // Offered only inside the Trash, so what goes was trashed. Were it
          // ever offered elsewhere, the counts would disagree and the grid
          // would re-page, which is all a wrong guess costs.
          const refused = expecting({ assets: -count, trashed: -count });
          void invoke({ type: "assets:remove", ids }).then((outcome) => {
            if (!outcome.ok) return refused(outcome.problem);
            onGone(ids);
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
  }, [ids, onNote, onProblem, onConfirm, onGone, onLeaving]);
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
  return count === 1 ? "1 asset" : `${counted(count)} assets`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
