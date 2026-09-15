import type { SidebarFolderRow } from "@roost/contract";
import { ContextMenu } from "radix-ui";

/**
 * A folder's own menu, wherever a folder is drawn (ADR-0033, ADR-0043 §5).
 *
 * Two controls draw folders now — the navigation pane and the grid — and the
 * menu over one has to be the same menu in both. It lives here for the reason
 * `folders.ts` does: the second control to ask a question should not write a
 * second, subtly different answer to it.
 *
 * The trigger is whatever it is given, `asChild`, so the row or the cell stays
 * the element it was.
 */

export interface FolderContextMenuProps {
  readonly row: SidebarFolderRow;
  /** A new folder inside this one (ADR-0033). */
  readonly onNewFolder: (parent: SidebarFolderRow) => void;
  readonly onRename: (folder: SidebarFolderRow) => void;
  /** `null` is the top level, which is the one destination a menu can name. */
  readonly onMoveFolder: (folder: number, parent: number | null) => void;
  readonly onDelete: (folder: SidebarFolderRow) => void;
  readonly children: React.ReactNode;
}

export function FolderContextMenu({
  row,
  onNewFolder,
  onRename,
  onMoveFolder,
  onDelete,
  children,
}: FolderContextMenuProps): React.JSX.Element {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={8}>
          <ContextMenu.Item className="menu-item" onSelect={() => onNewFolder(row)}>
            <span className="menu-mark" />
            <span className="menu-label">New subfolder…</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => onRename(row)}>
            <span className="menu-mark" />
            <span className="menu-label">Rename…</span>
          </ContextMenu.Item>
          {/*
            The keyboard's half of dragging a folder onto the heading. Only the
            one direction: moving a folder *into* another is a choice among
            every folder there is, which is a picker, and the drag is the
            gesture that already expresses it. Coming back out has exactly one
            destination.
          */}
          <ContextMenu.Item
            className="menu-item"
            disabled={row.depth === 0}
            onSelect={() => onMoveFolder(row.folder, null)}
          >
            <span className="menu-mark" />
            <span className="menu-label">Move to top level</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          {/*
            Not drawn in the danger ramp, though what it opens is: the asset
            menu does not colour `Delete permanently` either, and a red row in a
            menu is attention rather than meaning (`UI_SPEC.md` §2). The
            ellipsis is the promise that a dialog comes next, and the dialog is
            where the choice about the contents is made (ADR-0033).
          */}
          <ContextMenu.Item className="menu-item" onSelect={() => onDelete(row)}>
            <span className="menu-mark" />
            <span className="menu-label">Delete folder…</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
