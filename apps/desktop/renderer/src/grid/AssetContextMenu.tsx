import type { WireExportReport, WireProblem } from "@roost/contract";
import { ContextMenu } from "radix-ui";
import { useRef } from "react";
import { invoke } from "../bridge.js";
import { type ConfirmRequest, useTrashActions } from "./trash-actions.js";

/**
 * Right-click on the grid or on an open preview (`UI_SPEC.md` §3.3).
 *
 * The file actions a file manager has, on the assets a person has selected:
 * open in whatever the desktop uses, show it where it lives, copy the paths,
 * copy the originals out to a folder they choose, and delete. Everything here
 * acts on the **selection**, never on the asset the pointer happens to be over
 * — that distinction was a real bug on 2026-08-30, and the fix was to give
 * every edit a list of hashes and no way to learn how long it is.
 *
 * Right-clicking an asset that is not selected selects it first; right-clicking
 * one that is leaves the selection alone. `Grid` does that, because it is the
 * component that knows what is under the pointer. **In the preview there is
 * nothing to point at but the asset on screen**, so the menu is over that one
 * whatever else is selected — "export…" while looking at one picture cannot
 * sensibly mean the other eleven.
 *
 * **The menu changes inside the Trash.** Deleting is reversible everywhere else
 * and irreversible there, so the two spellings are never on screen together:
 * `Move to trash` outside it, `Restore` and `Delete permanently` inside it
 * (ADR-0022). Which one applies is decided by the query the grid is showing —
 * `inTrash` — rather than by asking the engine on every right-click, which is
 * what the rating and tag items are still waiting for.
 */

export interface AssetContextMenuProps {
  /** The selection. Empty means there is no menu to open. */
  readonly hashes: readonly string[];
  /** Whether what is on screen is the Trash place. */
  readonly inTrash: boolean;
  /** Something happened and the status bar should say so. */
  readonly onNote: (line: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
  /** Asks for the confirmation an irreversible action needs. */
  readonly onConfirm: (request: ConfirmRequest) => void;
  /** The assets acted on have left the view, so the selection naming them has to go. */
  readonly onGone: () => void;
  readonly children: React.ReactNode;
}

export function AssetContextMenu({
  hashes,
  inTrash,
  onNote,
  onProblem,
  onConfirm,
  onGone,
  children,
}: AssetContextMenuProps): React.JSX.Element {
  const count = hashes.length;
  const only = count === 1 ? hashes[0] : undefined;
  const restoreTo = useRef<HTMLElement | null>(null);

  const copyPaths = (): void => {
    void invoke({ type: "asset:copyPath", hashes }).then((outcome) => {
      if (!outcome.ok) onProblem(outcome.problem);
    });
  };

  // Two round trips on purpose: the dialog belongs to a window and the copying
  // belongs to the engine, and nothing in between should be holding a path in
  // the renderer for longer than it takes to hand it back.
  const exportTo = async (): Promise<void> => {
    const chosen = await invoke({ type: "dialog:chooseLocation" });
    if (!chosen.ok) return onProblem(chosen.problem);
    if (chosen.value === null) return;

    const done = await invoke({ type: "assets:export", hashes, destination: chosen.value });
    if (!done.ok) return onProblem(done.problem);
    onNote(exportLine(done.value));
  };

  const { trash, restore, deletePermanently, emptyTrash } = useTrashActions({
    hashes,
    onNote,
    onProblem,
    onConfirm,
    onGone,
  });

  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) {
          restoreTo.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
      }}
    >
      <ContextMenu.Trigger className="menu-area" disabled={count === 0}>
        {children}
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content
          className="menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            // Radix hands focus back to the trigger, which here is a plain
            // wrapper with no `tabindex` — so it would land on the body and the
            // arrow keys would stop working in whatever the menu was opened
            // over. Both of those are keyboard surfaces: the grid moves its
            // roving ring with them and the preview steps through the library.
            event.preventDefault();
            restoreTo.current?.focus();
          }}
        >
          <ContextMenu.Item
            className="menu-item"
            disabled={only === undefined}
            onSelect={() => {
              if (only !== undefined) void invoke({ type: "asset:openExternally", hash: only });
            }}
          >
            <span className="menu-mark" />
            <span className="menu-label">Open</span>
          </ContextMenu.Item>

          <ContextMenu.Item
            className="menu-item"
            disabled={only === undefined}
            onSelect={() => {
              if (only !== undefined) void invoke({ type: "asset:reveal", hash: only });
            }}
          >
            <span className="menu-mark" />
            <span className="menu-label">Show in file manager</span>
          </ContextMenu.Item>

          <ContextMenu.Separator className="menu-separator" />

          <ContextMenu.Item className="menu-item" onSelect={copyPaths}>
            <span className="menu-mark" />
            <span className="menu-label">{count === 1 ? "Copy path" : `Copy ${count} paths`}</span>
          </ContextMenu.Item>

          <ContextMenu.Item className="menu-item" onSelect={() => void exportTo()}>
            <span className="menu-mark" />
            <span className="menu-label">
              {count === 1 ? "Export…" : `Export ${count} assets…`}
            </span>
          </ContextMenu.Item>

          <ContextMenu.Separator className="menu-separator" />

          {inTrash ? (
            <>
              <ContextMenu.Item className="menu-item" onSelect={restore}>
                <span className="menu-mark" />
                <span className="menu-label">
                  {count === 1 ? "Restore" : `Restore ${count} assets`}
                </span>
              </ContextMenu.Item>

              <ContextMenu.Item className="menu-item" onSelect={deletePermanently}>
                <span className="menu-mark" />
                <span className="menu-label">Delete permanently</span>
              </ContextMenu.Item>

              <ContextMenu.Separator className="menu-separator" />

              <ContextMenu.Item className="menu-item" onSelect={emptyTrash}>
                <span className="menu-mark" />
                <span className="menu-label">Empty trash</span>
              </ContextMenu.Item>
            </>
          ) : (
            <ContextMenu.Item className="menu-item" onSelect={trash}>
              <span className="menu-mark" />
              <span className="menu-label">
                {count === 1 ? "Move to trash" : `Move ${count} assets to trash`}
              </span>
              <span className="menu-accelerator">Del</span>
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** What the status bar says after an export. */
export function exportLine(report: WireExportReport): string {
  const parts = [`Exported ${report.exported}`];
  if (report.renamed > 0) parts.push(`${report.renamed} renamed to avoid a collision`);
  if (report.missing > 0) parts.push(`${report.missing} not on this machine`);
  if (report.failed > 0) parts.push(`${report.failed} failed`);
  return parts.join(" · ");
}
