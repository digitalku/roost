import type { SidebarFolderRow } from "@roost/contract";
import { DropdownMenu } from "radix-ui";

/** Steps of indentation drawn; past this a row would be all indent. */
const MAX_INDENT = 8;

/**
 * The control that puts the selection in a folder (`UI_SPEC.md` §3.9).
 *
 * **A menu, not a field.** The tag field beside it takes typing because a tag
 * that does not exist yet is made by typing it; a folder is not. Nothing in the
 * window creates one — folders come from the sidebar and the CLI — so a text
 * field here would offer a gesture that can only fail, and the whole vocabulary
 * is a tree small enough to show at once.
 *
 * **The tree is drawn as a tree**, indented by the same depth the sidebar uses,
 * because the paths repeat: three folders called `Icons` are three rows reading
 * `Icons`, and the indentation is what tells them apart at a glance. The full
 * path is on each row's `title` for the case where it does not.
 *
 * A folder the selection is already in is **disabled rather than absent**: an
 * item that vanishes as it is used moves the next one under the pointer, and a
 * tree that changes shape between two openings is one nobody learns.
 */
export function FolderField({
  tree,
  attached,
  onAdd,
}: {
  /** Every folder in the library, in the order the sidebar draws them. */
  readonly tree: readonly SidebarFolderRow[];
  /** Folder ids the selection is already in — shared and partial alike. */
  readonly attached: readonly number[];
  readonly onAdd: (folder: number) => void;
}): React.JSX.Element {
  const held = new Set(attached);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {/*
          Disabled with an empty tree rather than hidden. A library with no
          folders yet is the state somebody most wants told about — the button
          is where the question "how do I file this?" gets asked, and a control
          that is not there answers nothing.
        */}
        <button
          type="button"
          className="folder-trigger"
          disabled={tree.length === 0}
          title={tree.length === 0 ? "This library has no folders yet" : undefined}
        >
          <span aria-hidden="true">+</span>
          <span>Add to folder</span>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" sideOffset={4} align="start" collisionPadding={8}>
          {tree.map((folder) => (
            <DropdownMenu.Item
              key={folder.id}
              className="menu-item folder-item"
              // The indent is in CSS, capped there like the sidebar's: a
              // `var(--token)` written into a style attribute is invisible to
              // `check:css`, which is the one thing that can see a typo in one.
              data-depth={folder.depth === 0 ? undefined : Math.min(folder.depth, MAX_INDENT)}
              disabled={held.has(folder.folder)}
              title={folder.path}
              onSelect={() => onAdd(folder.folder)}
            >
              <span className="menu-mark" />
              <span className="menu-label">{folder.name}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
