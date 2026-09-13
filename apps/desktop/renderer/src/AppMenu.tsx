import { DropdownMenu } from "radix-ui";

/**
 * The application menu, as one button in the toolbar (ADR-0028).
 *
 * The window has no menu bar: Electron's default one was File · Edit · View ·
 * Window, which nobody here designed, and which carried a Reload that throws
 * away the query and the selection, a devtools toggle, and a Paste meaning
 * something other than Roost's (ADR-0026 §5).
 *
 * **Only what has no better home is in here.** Add stays on the bar, because
 * bringing something in is the primary action of an empty library; the view
 * control stays on the bar, because it is ADR-0018's; per-asset commands stay
 * in the context menu. A menu that repeats the toolbar teaches people to look
 * in two places and to trust neither.
 */
export interface AppMenuProps {
  /**
   * Whether each side pane is on screen, and the two toggles for them
   * (ADR-0028 §6, `UI_SPEC.md` §1).
   *
   * They are in here rather than in the view menu because they are about the
   * **window**, not about the grid: ADR-0018's menu says how the results are
   * drawn, and every other item in it changes a cell. Asked for on 2026-09-13.
   *
   * The sidebar's own toggle is the reason this menu is reachable from two
   * places: the `☰` is drawn at the head of the sidebar, so hiding the sidebar
   * would hide the only way back. `App` moves it to the content head while the
   * sidebar is away.
   */
  readonly sidebar: boolean;
  readonly inspector: boolean;
  readonly onSidebar: (on: boolean) => void;
  readonly onInspector: (on: boolean) => void;
  readonly onCloseLibrary: () => void;
  /**
   * Delete the objects nothing references (ADR-0031).
   *
   * Here because it is the application acting on the whole library rather than
   * on anything selected, and because the trash is not where an orphan comes
   * from — a permanent delete takes its own bytes with it, so what is left is
   * the wreckage of interrupted work and of libraries older than that rule.
   */
  readonly onReclaim: () => void;
  /**
   * Who made this, which build it is, and how to reach support (ADR-0038 §5.1).
   *
   * The clearest case of this menu's own rule: an About box is read once, is
   * not about the selection, and has nowhere else to be. It is last but for
   * Quit, because it is the least often wanted thing in here.
   */
  readonly onAbout: () => void;
  readonly onQuit: () => void;
}

export function AppMenu({
  sidebar,
  inspector,
  onSidebar,
  onInspector,
  onCloseLibrary,
  onReclaim,
  onAbout,
  onQuit,
}: AppMenuProps): React.JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="app-menu-trigger" aria-label="Menu">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M2 4h12M2 8h12M2 12h12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" sideOffset={4} align="start" collisionPadding={8}>
          {/*
            First, and the only pair in here that is used more than once: the
            accelerators are the ones `UI_SPEC.md` §9 has named since M3 and
            they are bound on the window, not by this menu — a menu item is not
            a keybinding, and the keys have to work while the menu is shut.
          */}
          <DropdownMenu.CheckboxItem
            className="menu-item"
            checked={sidebar}
            onCheckedChange={onSidebar}
          >
            <span className="menu-mark">{sidebar ? "✓" : ""}</span>
            <span className="menu-label">Show sidebar</span>
            <span className="menu-accelerator">F9</span>
          </DropdownMenu.CheckboxItem>

          <DropdownMenu.CheckboxItem
            className="menu-item"
            checked={inspector}
            onCheckedChange={onInspector}
          >
            <span className="menu-mark">{inspector ? "✓" : ""}</span>
            <span className="menu-label">Show inspector</span>
            <span className="menu-accelerator">F4</span>
          </DropdownMenu.CheckboxItem>

          <DropdownMenu.Separator className="menu-separator" />

          <DropdownMenu.Item className="menu-item" onSelect={onReclaim}>
            <span className="menu-mark" />
            <span className="menu-label">Reclaim space…</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="menu-separator" />

          <DropdownMenu.Item className="menu-item" onSelect={onCloseLibrary}>
            <span className="menu-mark" />
            <span className="menu-label">Close library</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="menu-separator" />

          <DropdownMenu.Item className="menu-item" onSelect={onAbout}>
            <span className="menu-mark" />
            <span className="menu-label">About Roost…</span>
          </DropdownMenu.Item>

          {/*
            The accelerator is real and is bound in the shell, not here: a menu
            item is not a keybinding, and `Ctrl+Q` is what people press.
          */}
          <DropdownMenu.Item className="menu-item" onSelect={onQuit}>
            <span className="menu-mark" />
            <span className="menu-label">Quit</span>
            <span className="menu-accelerator">Ctrl+Q</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
