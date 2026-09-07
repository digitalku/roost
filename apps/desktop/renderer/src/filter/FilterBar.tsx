import type { SidebarRow, SidebarTypeRow, WireFacets, WireStars } from "@roost/contract";
import { STARS } from "@roost/contract";
import { DropdownMenu } from "radix-ui";

/**
 * The three filters over the grid: tags, rating, file type (ADR-0035).
 *
 * **It is a view of the query, not a second piece of state.** Everything drawn
 * here comes from `query:split`, and every click sends `query:join` and puts the
 * answer in the search field. So the field always shows what is on screen, which
 * is the promise `UI_SPEC.md` §4.2 makes and this is the first control large
 * enough to test it.
 *
 * It replaced the sidebar's Rating and Tags sections on the user's word, and the
 * difference between the two controls is the reason both should not exist: a
 * sidebar row **replaces** the query and a facet **narrows** it. Within a facet
 * the values are `OR`ed, because two ratings `AND`ed match nothing.
 *
 * The counts are the ones the pane used to draw, from the same read — what moved
 * is where they are shown, not what the engine answers.
 */

export interface FilterBarProps {
  readonly facets: WireFacets;
  /**
   * Whether the query is one the chips can describe.
   *
   * False for a top-level `OR`, or two terms of one facet. Nothing is drawn as
   * on then, and the bar says so rather than lying by omission — a chip that is
   * off next to a query that filters is worse than no chip.
   */
  readonly representable: boolean;
  /** Every tag in the library, with its count, in the pane's own order. */
  readonly tags: readonly SidebarRow[];
  /** The six rating rows, five stars then unrated, as the engine sends them. */
  readonly ratings: readonly SidebarRow[];
  readonly types: readonly SidebarTypeRow[];
  readonly onChange: (facets: WireFacets) => void;
}

export function FilterBar({
  facets,
  representable,
  tags,
  ratings,
  types,
  onChange,
}: FilterBarProps): React.JSX.Element {
  const chosen = representable ? facets : EMPTY;
  const anything =
    chosen.tags.length > 0 || chosen.stars.length > 0 || chosen.unrated || chosen.exts.length > 0;

  return (
    <div className="filter-bar" role="toolbar" aria-label="Filters">
      <Facet
        label="Tags"
        summary={summarise(chosen.tags)}
        count={chosen.tags.length}
        empty="No tags yet"
      >
        {/* Grouped, as the pane grouped them: a group is how somebody arranged
            their tags, and a flat list of ninety would not be usable. */}
        {groupTags(tags).map(([group, rows]) => (
          <Group key={group ?? "(ungrouped)"} name={group}>
            {rows.map((tag) => (
              <Choice
                key={tag.id}
                label={tag.name}
                count={tag.count}
                on={chosen.tags.includes(tag.name)}
                onToggle={(on) => onChange({ ...chosen, tags: toggle(chosen.tags, tag.name, on) })}
              />
            ))}
          </Group>
        ))}
      </Facet>

      <Facet
        label="Rating"
        summary={ratingSummary(chosen)}
        count={chosen.stars.length + (chosen.unrated ? 1 : 0)}
        empty="No ratings"
      >
        {ratings.map((row) =>
          // `stars` is `0` on the unrated row, which is not a rating of zero
          // (`DATA_MODEL.md`) — so it toggles its own field rather than joining
          // the list of stars.
          row.stars === 0 ? (
            <Choice
              key={row.id}
              label={row.name}
              count={row.count}
              on={chosen.unrated}
              onToggle={(on) => onChange({ ...chosen, unrated: on })}
            />
          ) : (
            <Choice
              key={row.id}
              label={row.name}
              stars={row.stars}
              count={row.count}
              on={isStars(row.stars) && chosen.stars.includes(row.stars)}
              onToggle={(on) =>
                isStars(row.stars) &&
                onChange({ ...chosen, stars: toggle(chosen.stars, row.stars, on) })
              }
            />
          ),
        )}
      </Facet>

      <Facet
        label="Types"
        summary={summarise(chosen.exts.map(spellExt))}
        count={chosen.exts.length}
        empty="Nothing imported yet"
      >
        {types.map((type) => (
          <Choice
            key={type.ext === "" ? "(none)" : type.ext}
            label={spellExt(type.ext)}
            count={type.count}
            on={chosen.exts.includes(type.ext)}
            onToggle={(on) => onChange({ ...chosen, exts: toggle(chosen.exts, type.ext, on) })}
          />
        ))}
      </Facet>

      {/* Only when there is something to clear: a permanently visible Clear is
          a control that does nothing most of the time (`UI_SPEC.md` §8). */}
      {anything && (
        <button type="button" className="filter-clear" onClick={() => onChange(EMPTY)}>
          Clear filters
        </button>
      )}

      {/*
        Said out loud rather than shown by absence. A query with a top-level
        `OR` in it filters the grid while every chip here reads as off, and
        somebody looking at three empty chips over two hundred assets would
        reasonably conclude nothing is filtering.
      */}
      {!representable && (
        <span className="filter-note">The search field holds a query these cannot show</span>
      )}
    </div>
  );
}

const EMPTY: WireFacets = { tags: [], stars: [], unrated: false, exts: [] };

/** One facet's button and menu. */
function Facet({
  label,
  summary,
  count,
  empty,
  children,
}: {
  readonly label: string;
  readonly summary: string | undefined;
  readonly count: number;
  readonly empty: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const items = Array.isArray(children) ? children : [children];
  return (
    /*
     * Not modal. A modal menu marks the rest of the window `aria-hidden` and
     * takes the scroll, and the grid behind this one is **the thing being
     * changed** — ticking a second tag while watching the count move is the
     * ordinary way this control is used.
     */
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {/*
          The button says what is chosen, not merely that something is. A bar
          whose chips only light up makes somebody open all three to find out
          which one is hiding their assets.
        */}
        <button type="button" className="filter-trigger" data-on={count > 0 ? "" : undefined}>
          <span className="filter-label">{label}</span>
          {summary !== undefined && <span className="filter-summary">{summary}</span>}
          <span className="filter-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu filter-menu"
          sideOffset={4}
          align="start"
          collisionPadding={8}
        >
          {items.flat().length === 0 ? (
            <div className="menu-item" data-disabled="">
              <span className="menu-mark" />
              <span className="menu-label">{empty}</span>
            </div>
          ) : (
            children
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * One tag group's heading and its tags.
 *
 * A label rather than a submenu: a group arranges tags, it does not contain
 * assets (`DATA_MODEL.md` §3), and burying eight tags one level down would make
 * choosing two of them a four-gesture job.
 */
function Group({
  name,
  children,
}: {
  readonly name: string | null;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <DropdownMenu.Group>
      {name !== null && <DropdownMenu.Label className="menu-heading">{name}</DropdownMenu.Label>}
      {children}
    </DropdownMenu.Group>
  );
}

/** One value in a facet's menu. The menu stays open, because several may be chosen. */
function Choice({
  label,
  stars,
  count,
  on,
  onToggle,
}: {
  readonly label: string;
  readonly stars?: number | null;
  readonly count: number | null;
  readonly on: boolean;
  readonly onToggle: (on: boolean) => void;
}): React.JSX.Element {
  return (
    <DropdownMenu.CheckboxItem
      className="menu-item"
      checked={on}
      // Choosing a second value is the ordinary case here, and a menu that
      // closed on the first would make it three gestures instead of one.
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={onToggle}
    >
      <span className="menu-mark">{on ? "✓" : ""}</span>
      <span className="menu-label">
        {stars === undefined || stars === null ? label : <Stars filled={stars} label={label} />}
      </span>
      {count !== null && <span className="menu-count">{count.toLocaleString()}</span>}
    </DropdownMenu.CheckboxItem>
  );
}

/**
 * Five stars, `filled` of them lit.
 *
 * The same fact the sidebar drew: the engine says how many, the window decides
 * what that looks like. The row's own name stays in the accessible tree, so a
 * screen reader still hears "3 stars".
 */
function Stars({ filled, label }: { readonly filled: number; readonly label: string }) {
  return (
    <>
      <span className="filter-stars" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((star) => (
          <span key={star} data-on={star <= filled ? "" : undefined}>
            ★
          </span>
        ))}
      </span>
      {/* The same arrangement the pane's rating rows used: the shape for the
          eye, the row's own name for a reader, and the tests go on asking for
          "3 stars". */}
      <span className="filter-stars-name">{label}</span>
    </>
  );
}

function isStars(value: number | null): value is WireStars {
  return value !== null && STARS.includes(value as WireStars);
}

/** Adds or removes one value, keeping the order the vocabulary is drawn in. */
function toggle<T>(values: readonly T[], value: T, on: boolean): T[] {
  return on ? [...values, value] : values.filter((held) => held !== value);
}

/** `wood`, `wood +2`, or nothing at all — a button is not the place for a list. */
function summarise(values: readonly string[]): string | undefined {
  const [first, ...rest] = values;
  if (first === undefined) return undefined;
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

function ratingSummary(facets: WireFacets): string | undefined {
  const stars = [...facets.stars].sort((a, b) => b - a);
  const names = [
    ...stars.map((count) => "★".repeat(count)),
    ...(facets.unrated ? ["No stars"] : []),
  ];
  return summarise(names);
}

/** Grouped tags first, in first-seen order; ungrouped last (`UI_SPEC.md` §4.1). */
function groupTags(tags: readonly SidebarRow[]): [string | null, SidebarRow[]][] {
  const groups = new Map<string | null, SidebarRow[]>();
  for (const tag of tags) {
    const existing = groups.get(tag.group);
    if (existing === undefined) groups.set(tag.group, [tag]);
    else existing.push(tag);
  }
  const ungrouped = groups.get(null);
  groups.delete(null);
  const ordered: [string | null, SidebarRow[]][] = [...groups];
  if (ungrouped !== undefined) ordered.push([null, ungrouped]);
  return ordered;
}

/** An asset with no extension is a real answer to "what is in here". */
function spellExt(ext: string): string {
  return ext === "" ? "No extension" : ext.toUpperCase();
}
