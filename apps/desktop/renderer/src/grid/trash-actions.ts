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
  readonly option?: {
    readonly label: string;
    /** Said under the checkbox: what it will leave alone, and why (ADR-0067 §3.2). */
    readonly note?: string;
  };
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
  /**
   * The folder on screen, when one is. `Delete` then takes the selection out
   * of it and trashes only what is in no other folder (ADR-0067).
   */
  readonly folder?: TrashFolder | undefined;
}

/** The folder a `Delete` is made inside (ADR-0067). */
export interface TrashFolder {
  readonly id: number;
  readonly name: string;
  /** The grid draws its subfolders too (*Show subfolder contents*, ADR-0036). */
  readonly subtree: boolean;
  /** A folder's path, for naming where a file taken out of this one still is. */
  readonly pathOf: (folder: number) => string | undefined;
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
  folder,
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
      if (folder !== undefined) {
        leaveFolder(folder);
        return;
      }
      const refused = expecting({ assets: 0, trashed: count });
      void invoke({ type: "assets:trash", ids }).then((outcome) => {
        if (!outcome.ok) return refused(outcome.problem);
        onGone(ids);
        onNote(`Moved ${assets(count)} to the trash`);
      });
    };

    /**
     * `Delete` inside a folder (ADR-0067): every asset leaves the view, and
     * only the ones in no other folder reach the trash.
     *
     * How many that is, the engine answers, so it is asked first and writes
     * nothing: the window has to say how far the trash count will move before
     * the change is announced (`onLeaving`). A membership changed between the
     * two by somebody else costs only a re-page.
     */
    const leaveFolder = (here: TrashFolder): void => {
      const asked = { ids, folder: here.id, subtree: here.subtree };
      void (async () => {
        const preview = await invoke({ type: "assets:deleteInFolderPreview", ...asked });
        if (!preview.ok) return onProblem(preview.problem);
        const refused = expecting({ assets: 0, trashed: preview.value.trashed });
        const outcome = await invoke({ type: "assets:deleteInFolder", ...asked });
        if (!outcome.ok) return refused(outcome.problem);
        const { trashed, removed, stillIn } = outcome.value;
        onGone(ids);
        onNote(leftFolderLine(trashed, removed, here.name, stillIn.map(here.pathOf)));
      })();
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
  }, [ids, onNote, onProblem, onConfirm, onGone, onLeaving, folder]);
}

/**
 * What the status bar says after a `Delete` inside a folder (ADR-0067 §3.1):
 * both halves, because a file still in another folder has not gone anywhere a
 * person would think to look for it in the trash.
 *
 * `stillIn` is the one removed asset's other folders, by path; it is empty when
 * several were removed, and a path the window does not know is left out.
 */
export function leftFolderLine(
  trashed: number,
  removed: number,
  folder: string,
  stillIn: readonly (string | undefined)[],
): string {
  if (removed === 0) return `Moved ${assets(trashed)} to the trash`;
  if (trashed === 0) {
    if (removed > 1) {
      return `Removed ${assets(removed)} from ${folder}. They are all still in other folders`;
    }
    const known = stillIn.filter((path): path is string => path !== undefined);
    const where =
      known.length === 1 && stillIn.length === 1
        ? known[0]
        : stillIn.length === 1
          ? "another folder"
          : `${counted(stillIn.length)} other folders`;
    return `Removed 1 asset from ${folder}. It is still in ${where}`;
  }
  const rest =
    removed === 1
      ? `1 is still in another folder, so it was only removed from ${folder}`
      : `${counted(removed)} are still in other folders, so they were only removed from ${folder}`;
  return `Moved ${assets(trashed)} to the trash. ${capitalise(rest)}`;
}

/**
 * What the status bar says after a folder is deleted (ADR-0067 §3.2).
 */
export function deletedFolderLine(folder: string, trashed: number, spared: number): string {
  if (trashed === 0 && spared === 0) {
    return `Deleted ${folder}. The assets in it are still in the library.`;
  }
  if (trashed === 0) {
    return `Deleted ${folder}. The ${assets(spared)} in it are still in other folders`;
  }
  const kept =
    spared === 0
      ? ""
      : spared === 1
        ? ". 1 stayed in another folder"
        : `. ${counted(spared)} stayed in other folders`;
  return `Deleted ${folder}, and moved ${assets(trashed)} to the trash${kept}`;
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
