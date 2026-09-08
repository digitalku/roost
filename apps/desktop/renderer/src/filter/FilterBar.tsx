import type {
  SidebarRow,
  SidebarTypeRow,
  WireFacets,
  WireStars,
  WireTagRule,
} from "@roost/contract";
import { STARS } from "@roost/contract";
import { DropdownMenu } from "radix-ui";
import { useCallback, useRef, useState } from "react";

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
 * the values are `OR`ed — except tags, which carry a rule (§7).
 *
 * The counts are the ones the pane used to draw, from the same read — what moved
 * is where they are shown, not what the engine answers.
 */

/** Past this many values, a facet's menu is searched rather than read (§7.3). */
const SEARCHABLE_FROM = 8;

export interface FilterBarProps {
  readonly facets: WireFacets;
  /**
   * Whether the query is one the chips can describe.
   *
   * False for a top-level `OR`, two ratings, two extensions, or a tag facet
   * that is half an `OR`. Nothing is drawn as on then, and the bar says so
   * rather than lying by omission — a chip that is off next to a query that
   * filters is worse than no chip.
   */
  readonly representable: boolean;
  /** Every tag in the library, with its count, in the pane's own order. */
  readonly tags: readonly SidebarRow[];
  /** The six rating rows, five stars then unrated, as the engine sends them. */
  readonly ratings: readonly SidebarRow[];
  readonly types: readonly SidebarTypeRow[];
  readonly onChange: (facets: WireFacets) => void;
  /**
   * Whether the query on screen reaches into subfolders (ADR-0036).
   *
   * Read out of the query where it names a folder, and out of the library's
   * setting where it does not — the window resolves those two before it gets
   * here, because which one applies is a fact about the query and this control
   * only draws it.
   */
  readonly subfolders: boolean;
  readonly onSubfolders: (on: boolean) => void;
}

/** One value in a facet's menu, before the menu decides how to draw it. */
interface Value {
  readonly key: string;
  readonly label: string;
  /** Filled stars, for a rating; `null` for a value that is not one. */
  readonly stars: number | null;
  readonly count: number | null;
  /** The heading this value sits under, or `null`. Tags use it for groups. */
  readonly group: string | null;
  readonly on: boolean;
  readonly toggle: (on: boolean) => void;
}

export function FilterBar({
  facets,
  representable,
  tags,
  ratings,
  types,
  onChange,
  subfolders,
  onSubfolders,
}: FilterBarProps): React.JSX.Element {
  const chosen = representable ? facets : { ...EMPTY, tagRule: facets.tagRule };
  const anything =
    chosen.tags.length > 0 || chosen.stars.length > 0 || chosen.unrated || chosen.exts.length > 0;

  const tagValues: readonly Value[] = tags.map((tag) => ({
    key: tag.id,
    label: tag.name,
    stars: null,
    count: tag.count,
    group: tag.group,
    on: chosen.tags.includes(tag.name),
    toggle: (on) => onChange({ ...chosen, tags: toggle(chosen.tags, tag.name, on) }),
  }));

  const ratingValues: readonly Value[] = ratings.map((row) => ({
    key: row.id,
    label: row.name,
    // `stars` is `0` on the unrated row, which is not a rating of zero
    // (`DATA_MODEL.md`) — so it toggles its own field rather than joining the
    // list of stars. Drawn as five unlit stars all the same.
    stars: row.stars,
    count: row.count,
    group: null,
    on: row.stars === 0 ? chosen.unrated : isStars(row.stars) && chosen.stars.includes(row.stars),
    toggle: (on) => {
      if (row.stars === 0) onChange({ ...chosen, unrated: on });
      else if (isStars(row.stars)) {
        onChange({ ...chosen, stars: toggle(chosen.stars, row.stars, on) });
      }
    },
  }));

  const typeValues: readonly Value[] = types.map((type) => ({
    key: type.ext === "" ? "(none)" : type.ext,
    label: spellExt(type.ext),
    stars: null,
    count: type.count,
    group: null,
    on: chosen.exts.includes(type.ext),
    toggle: (on) => onChange({ ...chosen, exts: toggle(chosen.exts, type.ext, on) }),
  }));

  return (
    <div className="filter-bar" role="toolbar" aria-label="Filters">
      <Facet
        label="Tags"
        summary={summarise(chosen.tags)}
        count={chosen.tags.length}
        empty="No tags yet"
        values={tagValues}
        searchLabel="Search tags"
        rule={chosen.tagRule}
        onRule={(next) => onChange({ ...chosen, tagRule: next })}
      />
      <Facet
        label="Rating"
        summary={ratingSummary(chosen)}
        count={chosen.stars.length + (chosen.unrated ? 1 : 0)}
        empty="No ratings"
        values={ratingValues}
        searchLabel="Search ratings"
      />
      <Facet
        label="Types"
        summary={summarise(chosen.exts.map(spellExt))}
        count={chosen.exts.length}
        empty="Nothing imported yet"
        values={typeValues}
        searchLabel="Search types"
      />

      {/*
        Not a facet, and drawn as a checkbox rather than a chip because of it
        (ADR-0036). A facet narrows what is on screen; this says how deep the
        **place** reaches, which is a different question and the reason it has
        no menu. It is a view of the query like everything else here: `folder:`
        ticks it, `infolder:` unticks it, and where the query names no folder it
        shows the library's setting — what the next folder opened will use.
      */}
      <label className="filter-check">
        <input
          type="checkbox"
          checked={subfolders}
          onChange={(changed) => onSubfolders(changed.target.checked)}
        />
        <span>Show subfolder contents</span>
      </label>

      {/* Only when there is something to clear: a permanently visible Clear is
          a control that does nothing most of the time (`UI_SPEC.md` §8). The
          rule is not a filter and survives — it is how the *next* two tags will
          be joined, and clearing has not said anything about that. */}
      {anything && (
        <button
          type="button"
          className="filter-clear"
          onClick={() => onChange({ ...EMPTY, tagRule: chosen.tagRule })}
        >
          Clear filters
        </button>
      )}

      {/*
        Said out loud rather than shown by absence. A query with a top-level
        `OR` in it filters the grid while every chip reads as off, and somebody
        looking at three empty chips over two hundred assets would reasonably
        conclude nothing is filtering.
      */}
      {!representable && (
        <span className="filter-note">The search field holds a query these cannot show</span>
      )}
    </div>
  );
}

const EMPTY: WireFacets = { tags: [], tagRule: "any", stars: [], unrated: false, exts: [] };

/** One facet's button and menu. */
function Facet({
  label,
  summary,
  count,
  empty,
  values,
  searchLabel,
  rule,
  onRule,
}: {
  readonly label: string;
  readonly summary: string | undefined;
  readonly count: number;
  readonly empty: string;
  readonly values: readonly Value[];
  readonly searchLabel: string;
  /** Only the tag facet has one; an asset has one rating and one extension. */
  readonly rule?: WireTagRule;
  readonly onRule?: (rule: WireTagRule) => void;
}): React.JSX.Element {
  const [needle, setNeedle] = useState("");
  const [open, setOpen] = useState(false);
  /**
   * A tick has just happened, so a close that arrives now is not the reader's.
   *
   * `onSelect`'s `preventDefault` is the documented way to keep a menu open,
   * and it holds for the **first** tick of a visit and not the second — found
   * by driving a real window on 2026-09-08, where choosing two tags in one
   * visit shut the menu on the second. Every component test passed: happy-dom
   * dispatches the sequence differently.
   *
   * So the open state is controlled here and a close that lands during a tick
   * is refused. Cleared in a microtask, which runs after the synchronous
   * decision Radix is making and before anything a person could do next — an
   * `Escape` or a click outside still closes the menu, because neither is
   * inside a tick.
   */
  const ticking = useRef(false);
  const tick = useCallback(() => {
    ticking.current = true;
    queueMicrotask(() => {
      ticking.current = false;
    });
  }, []);
  // A field over five tags costs a row and saves nothing (§7.3).
  const searchable = values.length > SEARCHABLE_FROM;
  const matching = searchable ? values.filter((value) => matches(value, needle)) : values;

  /*
   * The caret belongs in the field the moment the menu opens, or the first
   * letter typed ticks a value instead of searching for it.
   *
   * On mount and a frame late, because a `radix-ui` menu focuses itself when it
   * opens and would take the caret straight back. `ArrowDown` still walks into
   * the list: the field is inside the content, so the key reaches the menu's own
   * handler by bubbling.
   */
  const takeCaret = useCallback((node: HTMLInputElement | null) => {
    if (node === null) return;
    requestAnimationFrame(() => node.focus());
  }, []);

  return (
    /*
     * Not modal. A modal menu marks the rest of the window `aria-hidden` and
     * takes the scroll, and the grid behind this one is **the thing being
     * changed** — ticking a second tag while watching the count move is the
     * ordinary way this control is used.
     */
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!next && ticking.current) return;
        setOpen(next);
        if (next) setNeedle("");
      }}
    >
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
          {rule !== undefined && onRule !== undefined && <Rule rule={rule} onRule={onRule} />}

          {searchable && (
            <div className="filter-search">
              <input
                ref={takeCaret}
                type="search"
                className="filter-search-input"
                aria-label={searchLabel}
                placeholder={searchLabel}
                spellCheck={false}
                value={needle}
                onChange={(changed) => setNeedle(changed.target.value)}
                // A `radix-ui` menu binds printable keys to jump between its
                // items, so `w` would select `wood` rather than reach the
                // field. Only those are taken: the arrows, `Escape` and `Tab`
                // are the menu's and go on working.
                onKeyDown={(event) => {
                  if (event.key.length === 1) event.stopPropagation();
                }}
              />
            </div>
          )}

          {matching.length === 0 ? (
            <div className="menu-item" data-disabled="">
              <span className="menu-mark" />
              <span className="menu-label">{values.length === 0 ? empty : "Nothing matches"}</span>
            </div>
          ) : (
            grouped(matching).map(([group, rows]) => (
              <DropdownMenu.Group key={group ?? "(ungrouped)"}>
                {/* A label rather than a submenu: a group arranges tags, it does
                    not contain assets (`DATA_MODEL.md` §3), and burying eight of
                    them one level down would make choosing two a four-gesture
                    job. */}
                {group !== null && (
                  <DropdownMenu.Label className="menu-heading">{group}</DropdownMenu.Label>
                )}
                {rows.map((value) => (
                  <Choice key={value.key} value={value} onTick={tick} />
                ))}
              </DropdownMenu.Group>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Any or All, for the tag facet (ADR-0035 §7).
 *
 * Two buttons rather than menu items, so choosing one does not close the menu
 * somebody is halfway through using — the same arrangement the view menu's zoom
 * row has. `aria-pressed` rather than a radio group: this is a toggle over what
 * is already on screen, not a value being submitted.
 */
function Rule({
  rule,
  onRule,
}: {
  readonly rule: WireTagRule;
  readonly onRule: (rule: WireTagRule) => void;
}): React.JSX.Element {
  return (
    <div className="menu-item filter-rule">
      <span className="menu-label">Rule</span>
      <div className="filter-rule-choices">
        {(["any", "all"] as const).map((candidate) => {
          const label = candidate === "any" ? "Any" : "All";
          return (
            <button
              key={candidate}
              type="button"
              className="filter-rule-button"
              // The word beside the buttons said again on each of them: the
              // heading is a `span` rather than a labelled group, so "Any" on
              // its own would reach a reader with nothing to be any *of*. The
              // visible word is inside the spoken one, which is what keeps the
              // button operable by voice.
              aria-label={`Rule: ${label}`}
              aria-pressed={rule === candidate}
              data-on={rule === candidate ? "" : undefined}
              onClick={() => onRule(candidate)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One value in a facet's menu. The menu stays open, because several may be chosen. */
function Choice({
  value,
  onTick,
}: {
  readonly value: Value;
  readonly onTick: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenu.CheckboxItem
      className="menu-item"
      checked={value.on}
      // Choosing a second value is the ordinary case here, and a menu that
      // closed on the first would make it three gestures instead of one. Both
      // halves are needed: `preventDefault` is what Radix documents, and it
      // holds for one tick a visit — see `ticking` above.
      onSelect={(event) => {
        onTick();
        event.preventDefault();
      }}
      onCheckedChange={value.toggle}
    >
      <span className="menu-mark">{value.on ? "✓" : ""}</span>
      <span className="menu-label">
        {value.stars === null ? value.label : <Stars filled={value.stars} label={value.label} />}
      </span>
      {value.count !== null && <span className="menu-count">{value.count.toLocaleString()}</span>}
    </DropdownMenu.CheckboxItem>
  );
}

/**
 * Five stars, `filled` of them lit.
 *
 * The same fact the sidebar drew: the engine says how many, the window decides
 * what that looks like.
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

function matches(value: Value, needle: string): boolean {
  const wanted = needle.trim().toLowerCase();
  return wanted === "" || value.label.toLowerCase().includes(wanted);
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

/** Grouped values first, in first-seen order; ungrouped last (`UI_SPEC.md` §4.1). */
function grouped(values: readonly Value[]): [string | null, Value[]][] {
  const groups = new Map<string | null, Value[]>();
  for (const value of values) {
    const existing = groups.get(value.group);
    if (existing === undefined) groups.set(value.group, [value]);
    else existing.push(value);
  }
  const ungrouped = groups.get(null);
  groups.delete(null);
  const ordered: [string | null, Value[]][] = [...groups];
  if (ungrouped !== undefined) ordered.push([null, ungrouped]);
  return ordered;
}

/** An asset with no extension is a real answer to "what is in here". */
function spellExt(ext: string): string {
  return ext === "" ? "No extension" : ext.toUpperCase();
}
