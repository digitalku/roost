import { DropdownMenu } from "radix-ui";
import { DEFAULT_ZOOM, GRID_VIEWS, type GridView, ZOOM_STEPS } from "./layout.js";

/**
 * The view control: one toolbar button, one menu (ADR-0018).
 *
 * The shape is a file manager's — a radio group of named views with `Ctrl+1..3`,
 * then zoom, then sort, then grouping — because that is where somebody who has
 * used a computer already looks for "show me a table with a size column". The
 * two-button toggle it replaces taught nothing and had nowhere to put the two
 * things `UI_SPEC.md` §6 had promised since M3.
 *
 * **Match image proportions is a checkbox under Icons, not a fourth view.** It
 * is the layout formerly called masonry, and it is a property of how an icon is
 * shaped rather than a peer of the three — which is what it always was. It is
 * also the only layout here that does not crop, which matters in an application
 * for looking at pictures.
 *
 * Drawn rather than native. ADR-0021 records why, and the short version is that
 * Electron's menus on Linux are not GTK menus either, and a native one could not
 * carry the zoom row.
 */

const LABELS: Readonly<Record<GridView, string>> = {
  icons: "Icons",
  compact: "Compact",
  details: "Details",
};

export interface ViewMenuProps {
  readonly view: GridView;
  readonly proportional: boolean;
  readonly zoom: number;
  readonly onView: (view: GridView) => void;
  readonly onProportional: (proportional: boolean) => void;
  readonly onZoom: (zoom: number) => void;
}

export function ViewMenu({
  view,
  proportional,
  zoom,
  onView,
  onProportional,
  onZoom,
}: ViewMenuProps): React.JSX.Element {
  const first = ZOOM_STEPS[0] ?? DEFAULT_ZOOM;
  const last = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? DEFAULT_ZOOM;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="view-trigger" aria-label="View">
          {/*
            All three labels, stacked, with the two that are not current merely
            invisible. The button is then the width of the longest of them
            whichever is showing, so switching the view does not resize the
            control that switched it — "Icons" is a shorter word than "Details",
            and a button that shrank when it was used made the whole bar shift.

            A reserved width rather than a `min-width` in pixels, because the
            number would be wrong at the next font size and nothing would say so.
          */}
          <span className="view-label">
            {GRID_VIEWS.map((candidate) => (
              <span key={candidate} data-current={candidate === view || undefined}>
                {LABELS[candidate]}
              </span>
            ))}
          </span>
          <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" sideOffset={4} align="start" collisionPadding={8}>
          <DropdownMenu.RadioGroup value={view} onValueChange={(next) => onView(next as GridView)}>
            {GRID_VIEWS.map((candidate, index) => (
              <DropdownMenu.RadioItem key={candidate} className="menu-item" value={candidate}>
                <span className="menu-mark">{view === candidate ? "●" : ""}</span>
                <span className="menu-label">{LABELS[candidate]}</span>
                <span className="menu-accelerator">Ctrl+{index + 1}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          {/*
            Nested under Icons rather than listed beside the views, and hidden
            when another view is on: it says nothing about a compact row or a
            details row, and a control that does nothing is worse than an absent
            one (`UI_SPEC.md` §8).
          */}
          {view === "icons" && (
            <DropdownMenu.CheckboxItem
              className="menu-item"
              data-nested=""
              checked={proportional}
              onCheckedChange={onProportional}
            >
              <span className="menu-mark">{proportional ? "✓" : ""}</span>
              <span className="menu-label">Match image proportions</span>
            </DropdownMenu.CheckboxItem>
          )}

          <DropdownMenu.Separator className="menu-separator" />

          {/*
            A row of buttons rather than three items, which is what the file
            manager this borrows from does — and the one thing a native menu
            could not have carried (ADR-0021).
          */}
          <div className="menu-item menu-zoom">
            <span className="menu-label">Zoom</span>
            <div className="zoom-controls">
              <ZoomStep
                label="Zoom out"
                glyph="−"
                disabled={zoom <= first}
                onPick={() => onZoom(-1)}
              />
              <ZoomStep label="Reset zoom" glyph="⟳" disabled={false} onPick={() => onZoom(0)} />
              <ZoomStep
                label="Zoom in"
                glyph="+"
                disabled={zoom >= last}
                onPick={() => onZoom(1)}
              />
            </div>
          </div>

          <DropdownMenu.Separator className="menu-separator" />

          {/*
            Promised here because this is where a person looks for them, and
            disabled because neither is a renderer change: the application has
            one order — `imported_at DESC, hash` — and keyset paging plus every
            composite index in migration 0005 is built on it (ADR-0018).
          */}
          <DropdownMenu.Item className="menu-item" disabled>
            <span className="menu-mark" />
            <span className="menu-label">Sort By</span>
            <span className="menu-accelerator">›</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" disabled>
            <span className="menu-mark" />
            <span className="menu-label">Group By</span>
            <span className="menu-accelerator">›</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * One zoom button, and a real menu item underneath.
 *
 * A bare `<button>` inside the content would be invisible to the menu's roving
 * focus — Radix navigates its own items, so the three would be reachable by
 * pointer and by nothing else, against `UI_SPEC.md` §10. `asChild` keeps the
 * row of buttons and puts each one in the keyboard order.
 *
 * `preventDefault` on select is what keeps the menu open, which is the point of
 * a row rather than three separate items: zooming twice should not cost two
 * trips through the menu.
 */
function ZoomStep({
  label,
  glyph,
  disabled,
  onPick,
}: {
  readonly label: string;
  readonly glyph: string;
  readonly disabled: boolean;
  readonly onPick: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenu.Item
      asChild
      disabled={disabled}
      onSelect={(event) => {
        event.preventDefault();
        onPick();
      }}
    >
      <button type="button" aria-label={label}>
        {glyph}
      </button>
    </DropdownMenu.Item>
  );
}
