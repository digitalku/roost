import { DropdownMenu } from "radix-ui";
import { useRef } from "react";

/**
 * The one control that brings an asset into the library (`UI_SPEC.md` §1).
 *
 * It was a bare **Import…** button, which named one of the four ways in and
 * hid the rest: the other three lived only in the context menu over the grid's
 * empty space — a place nobody right-clicks in an application they have just
 * opened, and one that is not even reachable while a file is on screen.
 *
 * **Add is the verb, and the items are where the bytes come from.** Two make
 * them here, three take them from the filesystem, and the separator is the
 * whole of the difference. Nothing else joins this menu: it is not a File menu
 * (ADR-0028 removed the menu bar), and a per-asset command belongs to the
 * asset.
 *
 * The two import items open **different dialogs**, not one dialog filtered.
 * Given both `openFile` and `openDirectory` every desktop draws the file
 * chooser and merely permits a directory in it, so importing a folder meant
 * selecting it from its parent — the one view that does not show its contents.
 * Asking here costs a menu item and buys a chooser that behaves.
 */
export interface AddMenuProps {
  /** Opens the New file dialog with an empty name. */
  readonly onNewFile: () => void;
  /** The same dialog, with the extension already typed. */
  readonly onNewTextDocument: () => void;
  readonly onImportFiles: () => void;
  readonly onImportFolder: () => void;
  /** Opens the Eagle chooser, then the survey dialog (ADR-0032). */
  readonly onImportEagle: () => void;
  /** An import is running, and there is one at a time (`useImport`). */
  readonly busy: boolean;
}

export function AddMenu({
  onNewFile,
  onNewTextDocument,
  onImportFiles,
  onImportFolder,
  onImportEagle,
  busy,
}: AddMenuProps): React.JSX.Element {
  /**
   * Whether the item just chosen opens a dialog.
   *
   * A ref rather than state: it is read once, in the handler that fires on the
   * way out, and re-rendering the menu as it closes would be a render for
   * nothing.
   */
  const opening = useRef(false);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {/*
          Named rather than a bare `+`. The glyph alone is what a toolbar uses
          when it has no room for a word, and this bar has room — the search
          field gives up its width to the two controls beside it and nothing
          else competes (`UI_SPEC.md` §1).
        */}
        <button type="button" className="add-trigger">
          <span aria-hidden="true">+</span>
          <span>Add</span>
          <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu"
          sideOffset={4}
          align="end"
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            // Radix returns focus to the trigger as the menu closes, and that
            // happens **after** the dialog these two items open has taken it —
            // so the caret sat in a field nothing was typing into. Found in a
            // real window; jsdom focuses nothing to steal.
            //
            // Only for those two. Escape, and the two import items, still want
            // the trigger back: a native file chooser takes the focus itself
            // and hands it here on the way out.
            if (!opening.current) return;
            opening.current = false;
            event.preventDefault();
          }}
        >
          {/*
            Both open the same dialog, and the second one has already answered
            the part of it that is a guess: the extension. It is not a second
            kind of file — Roost has no file types, only bytes and a name — so
            the two items differ by what is in the field when it opens.
          */}
          <DropdownMenu.Item
            className="menu-item"
            onSelect={() => {
              opening.current = true;
              onNewFile();
            }}
          >
            <span className="menu-mark" />
            <span className="menu-label">New file…</span>
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className="menu-item"
            onSelect={() => {
              opening.current = true;
              onNewTextDocument();
            }}
          >
            <span className="menu-mark" />
            <span className="menu-label">New text document…</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="menu-separator" />

          {/*
            Disabled while a run is going, because `useImport` holds one at a
            time — two would interleave a journal's worth of records with one
            status bar to report them. Disabled rather than absent: an item that
            vanishes mid-import is a menu that changes shape while being read.
          */}
          <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={onImportFiles}>
            <span className="menu-mark" />
            <span className="menu-label">Import files…</span>
            <span className="menu-accelerator">Ctrl+I</span>
          </DropdownMenu.Item>

          <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={onImportFolder}>
            <span className="menu-mark" />
            <span className="menu-label">Import folder…</span>
            <span className="menu-accelerator">Ctrl+Shift+I</span>
          </DropdownMenu.Item>

          {/*
            In this group and not a separator away from it: it is an import, and
            the group is "where the bytes come from". No accelerator — the two
            above have the obvious pair, and a third would be an arbitrary
            keystroke for something somebody does once.

            It goes through a native chooser like the other two, so
            `opening.current` stays false and Radix may take the focus back.
          */}
          <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={onImportEagle}>
            <span className="menu-mark" />
            <span className="menu-label">Import from Eagle…</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
