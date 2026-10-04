import { SORT_KEYS, type SortKey, type WireSort } from "@roost/contract";
import { DropdownMenu } from "radix-ui";
import { GRID_VIEWS, type GridView, ZOOMS } from "./layout.js";

/**
 * The view control: one toolbar button, one menu (ADR-0018).
 *
 * The shape is a file manager's — a radio group of named views with `Ctrl+1..3`,
 * then zoom, then sort — because that is where somebody who has used a computer
 * already looks for "show me a table with a size column". The two-button toggle
 * it replaces taught nothing and had nowhere to put the things `UI_SPEC.md` §6
 * had promised since M3.
 *
 * **Group By is not here and is not coming.** It stood in this menu as a
 * disabled promise from ADR-0018 until 2026-09-09, when the user asked for the
 * sort and said to drop the half that had never been built. A menu item that
 * has never done anything is a menu item nobody should read twice (ADR-0039
 * §8).
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

/**
 * What each order is called, which way round it runs by default, and what the
 * two ways are called in that key's own words.
 *
 * The words are the key's rather than a direction: nobody wants "imported
 * ascending", they want *Newest first*. `descending` is what the engine is told
 * (ADR-0039), and this table is the only place the two vocabularies meet.
 *
 * **Choosing a key sets its own direction**, because the answer somebody wants
 * from a key is nearly always the same one: newest, largest, highest — and A to
 * Z, which is the one that runs the other way. Keeping the last key's direction
 * would make *Name* mean Z to A for anyone who had been looking at the newest
 * first, which is every library by default.
 */
const SORTS: Readonly<
  Record<SortKey, { label: string; down: string; up: string; descending: boolean }>
> = {
  added: { label: "Date added", down: "Newest first", up: "Oldest first", descending: true },
  created: { label: "Date created", down: "Newest first", up: "Oldest first", descending: true },
  name: { label: "Name", down: "Z to A", up: "A to Z", descending: false },
  size: { label: "Size", down: "Largest first", up: "Smallest first", descending: true },
  rating: { label: "Rating", down: "Highest first", up: "Lowest first", descending: true },
  random: { label: "Random", down: "Shuffled", up: "Shuffled", descending: false },
};

export interface ViewMenuProps {
  readonly view: GridView;
  readonly proportional: boolean;
  /** The zoom of the view on screen: each view has its own (ADR-0039 §10). */
  readonly zoom: number;
  readonly sort: WireSort;
  readonly onView: (view: GridView) => void;
  readonly onProportional: (proportional: boolean) => void;
  readonly onZoom: (zoom: number) => void;
  readonly onSort: (sort: WireSort) => void;
  /** Rolls a new shuffle, which is the only way `random` changes (ADR-0039). */
  readonly onShuffle: () => void;
  /**
   * Whether the grid draws folders: the ones inside the folder on screen
   * (ADR-0043), and the ones a search finds (ADR-0057).
   */
  readonly showFolders: boolean;
  readonly onShowFolders: (on: boolean) => void;
}

export function ViewMenu({
  view,
  proportional,
  zoom,
  sort,
  onView,
  onProportional,
  onZoom,
  onSort,
  onShuffle,
  showFolders,
  onShowFolders,
}: ViewMenuProps): React.JSX.Element {
  const { steps, initial } = ZOOMS[view];
  const first = steps[0] ?? initial;
  const last = steps[steps.length - 1] ?? initial;

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

          {/*
            The folders drawn among the thumbnails (ADR-0043 §9).

            Here rather than in the filter bar on ADR-0028 §6's test: this menu
            says how the content region is drawn, and the tiles are drawn in it
            — while *Show subfolder contents* changes the **query**, which is
            what the bar is a view of.

            It was disabled while that checkbox was on, until the tiles were
            drawn there too (ADR-0043 §3, amended 2026-10-01).
          */}
          <DropdownMenu.CheckboxItem
            className="menu-item"
            checked={showFolders}
            onCheckedChange={onShowFolders}
          >
            <span className="menu-mark">{showFolders ? "✓" : ""}</span>
            <span className="menu-label">Show folders</span>
          </DropdownMenu.CheckboxItem>

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
            A submenu rather than eleven more rows: the key and the direction
            are one decision made in two parts, and the trigger says which one
            is on so the answer is readable without opening it.
          */}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="menu-item">
              <span className="menu-mark" />
              <span className="menu-label">Sort By</span>
              <span className="menu-accelerator">{SORTS[sort.key].label}</span>
              <span className="menu-arrow" aria-hidden="true">
                ›
              </span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="menu" sideOffset={2} collisionPadding={8}>
                <DropdownMenu.RadioGroup
                  value={sort.key}
                  onValueChange={(next) =>
                    onSort({
                      ...sort,
                      key: next as SortKey,
                      descending: SORTS[next as SortKey].descending,
                    })
                  }
                >
                  {SORT_KEYS.map((key) => (
                    <DropdownMenu.RadioItem key={key} className="menu-item" value={key}>
                      <span className="menu-mark">{sort.key === key ? "●" : ""}</span>
                      <span className="menu-label">{SORTS[key].label}</span>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>

                <DropdownMenu.Separator className="menu-separator" />

                {/*
                  A shuffle has no direction — reversing one is another shuffle
                  — so where the two ways round would be, `random` offers the
                  one thing it can be asked for instead.
                */}
                {sort.key === "random" ? (
                  <DropdownMenu.Item className="menu-item" onSelect={() => onShuffle()}>
                    <span className="menu-mark" />
                    <span className="menu-label">Shuffle again</span>
                  </DropdownMenu.Item>
                ) : (
                  <DropdownMenu.RadioGroup
                    value={sort.descending ? "down" : "up"}
                    onValueChange={(next) => onSort({ ...sort, descending: next === "down" })}
                  >
                    {(["down", "up"] as const).map((way) => (
                      <DropdownMenu.RadioItem key={way} className="menu-item" value={way}>
                        <span className="menu-mark">
                          {sort.descending === (way === "down") ? "●" : ""}
                        </span>
                        <span className="menu-label">{SORTS[sort.key][way]}</span>
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                )}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
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
