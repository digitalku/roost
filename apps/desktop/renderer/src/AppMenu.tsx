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
  readonly onCloseLibrary: () => void;
  readonly onQuit: () => void;
}

export function AppMenu({ onCloseLibrary, onQuit }: AppMenuProps): React.JSX.Element {
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
          <DropdownMenu.Item className="menu-item" onSelect={onCloseLibrary}>
            <span className="menu-mark" />
            <span className="menu-label">Close library</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="menu-separator" />

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
