import type { WireProblem, WireTagEntry, WireTagGroup, WireTagList } from "@roost/contract";
import { ContextMenu } from "radix-ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { TAG_DRAG_TYPE } from "../dnd.js";
import { counted } from "../format.js";
import type { ConfirmRequest } from "../grid/trash-actions.js";
import { NameDialog } from "./NameDialog.js";

/**
 * The tags page (ADR-0061): every tag, sorted into groups, renamed, merged,
 * deleted. It takes the place of the grid while it is open, as Eagle's does.
 *
 * Groups on the left, the tags of the one chosen on the right. Everything it
 * draws comes from `tags:list`, read again whenever the library changes, so a
 * tag added in the inspector appears here without anybody reopening the page.
 * It holds no list of its own to keep in step: every edit is a request, and the
 * answer is the next read.
 */

/** Which tags the right-hand list holds: every one, the ungrouped, or a group's. */
type Place = "all" | "none" | number;

type Order = "name" | "count";

/** The one dialog the page has open at a time. */
type Naming =
  | { readonly kind: "new-tag" }
  | { readonly kind: "rename-tag"; readonly from: string }
  | { readonly kind: "new-group"; readonly moving: readonly string[] }
  | { readonly kind: "rename-group"; readonly group: WireTagGroup };

export interface TagsPageProps {
  /** Moves on every edit the engine announces; the page reads again on it. */
  readonly generation: number;
  /** Drawn at the head of the page's bar: the `☰` when the sidebar is away, and Back. */
  readonly lead: React.ReactNode;
  /** Leaves the page for the grid, showing what carries a tag. */
  readonly onShowAssets: (query: string) => void;
  readonly onConfirm: (request: ConfirmRequest) => void;
  readonly onNote: (line: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
}

const NO_LIST: WireTagList = { groups: [], tags: [] };

export function TagsPage({
  generation,
  lead,
  onShowAssets,
  onConfirm,
  onNote,
  onProblem,
}: TagsPageProps): React.JSX.Element {
  const [list, setList] = useState<WireTagList | undefined>();
  const [place, setPlace] = useState<Place>("all");
  const [needle, setNeedle] = useState("");
  const [order, setOrder] = useState<Order>("name");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const anchor = useRef<string | undefined>(undefined);
  const [naming, setNaming] = useState<Naming | undefined>();
  const listbox = useRef<HTMLDivElement>(null);
  /**
   * A menu item has just opened a dialog, so the menu closing must not hand the
   * focus back to what it was opened over.
   *
   * Radix returns the focus to a menu's trigger as it closes, and a modal
   * dialog that loses the focus it has just taken closes itself: found driving
   * a window on 2026-10-24, where *New group…* opened its dialog for a frame,
   * and the `Enter` meant for it reached the list and left the page.
   */
  const handOff = useRef(false);
  const handingOff = useCallback(
    (run: () => void) => (): void => {
      handOff.current = true;
      run();
    },
    [],
  );
  const closeAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    if (handOff.current) {
      handOff.current = false;
      return;
    }
    listbox.current?.focus({ preventScroll: true });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the generation is the trigger
  useEffect(() => {
    let current = true;
    void (async () => {
      const read = await invoke({ type: "tags:list" });
      if (!current) return;
      if (read.ok) setList(read.value);
      else onProblem(read.problem);
    })();
    return () => {
      current = false;
    };
  }, [generation, onProblem]);

  const held = list ?? NO_LIST;
  /**
   * A group just made here, which the list has not caught up with yet: the
   * page goes to it at once, and the read that brings it is a moment behind.
   */
  const awaiting = useRef<number | undefined>(undefined);
  // A group that went away, from here or from the CLI, takes the page back to
  // every tag rather than leaving it on a list of nothing.
  useEffect(() => {
    if (typeof place !== "number") return;
    if (held.groups.some((group) => group.id === place)) {
      if (awaiting.current === place) awaiting.current = undefined;
      return;
    }
    if (awaiting.current !== place) setPlace("all");
  }, [held.groups, place]);

  const groups = useMemo(() => new Map(held.groups.map((group) => [group.id, group])), [held]);

  const shown = useMemo(() => {
    const wanted = needle.trim().toLowerCase();
    const rows = held.tags.filter(
      (tag) =>
        (place === "all" || (place === "none" ? tag.group === null : tag.group === place)) &&
        (wanted === "" || tag.name.toLowerCase().includes(wanted)),
    );
    return order === "name" ? rows : [...rows].sort((a, b) => b.count - a.count);
  }, [held, place, needle, order]);

  // What is chosen and no longer shown is not chosen: a filter typed, a group
  // changed, a tag deleted. Otherwise Delete would act on tags nobody can see.
  useEffect(() => {
    setChosen((was) => {
      const visible = new Set(shown.map((tag) => tag.name));
      const kept = was.filter((name) => visible.has(name));
      return kept.length === was.length ? was : kept;
    });
  }, [shown]);

  const choose = useCallback(
    (name: string, how: { readonly add: boolean; readonly range: boolean }) => {
      setChosen((was) => {
        if (how.range && anchor.current !== undefined) {
          const from = shown.findIndex((tag) => tag.name === anchor.current);
          const to = shown.findIndex((tag) => tag.name === name);
          if (from >= 0 && to >= 0) {
            const [low, high] = from < to ? [from, to] : [to, from];
            return shown.slice(low, high + 1).map((tag) => tag.name);
          }
        }
        anchor.current = name;
        if (how.add) return was.includes(name) ? was.filter((n) => n !== name) : [...was, name];
        return [name];
      });
    },
    [shown],
  );

  const edit = useCallback(
    async (
      run: () => ReturnType<typeof invoke>,
      line: string,
    ): Promise<WireProblem | undefined> => {
      const done = await run();
      if (!done.ok) return done.problem;
      onNote(line);
      return undefined;
    },
    [onNote],
  );

  const moveTo = useCallback(
    (names: readonly string[], group: number | null) => {
      if (names.length === 0) return;
      const where = group === null ? "no group" : (groups.get(group)?.name ?? "the group");
      void edit(
        () => invoke({ type: "tag:group", tags: names, group }),
        `Moved ${tagsNamed(names)} to ${where}`,
      ).then((refused) => refused !== undefined && onProblem(refused));
    },
    [edit, groups, onProblem],
  );

  const deleteChosen = useCallback(
    (names: readonly string[]) => {
      if (names.length === 0) return;
      const one = names.length === 1 ? held.tags.find((tag) => tag.name === names[0]) : undefined;
      onConfirm({
        title: names.length === 1 ? `Delete ${names[0]}?` : `Delete ${names.length} tags?`,
        // A sum over several tags would count an asset carrying two of them
        // twice, so a number is given only where it is true.
        body:
          one !== undefined
            ? `It comes off ${assetsCount(one.count)}. The assets are otherwise untouched.`
            : "They come off every asset that carries them. The assets are otherwise untouched.",
        confirmLabel: "Delete",
        run: () => {
          void edit(
            () => invoke({ type: "tag:delete", tags: names }),
            `Deleted ${tagsNamed(names)}`,
          ).then((refused) => refused !== undefined && onProblem(refused));
        },
      });
    },
    [edit, held.tags, onConfirm, onProblem],
  );

  const deleteGroup = useCallback(
    (group: WireTagGroup) => {
      onConfirm({
        title: `Delete the group ${group.name}?`,
        body:
          group.tags === 0
            ? "It holds no tags."
            : `Its ${counted(group.tags)} ${group.tags === 1 ? "tag stays" : "tags stay"}, in no group.`,
        confirmLabel: "Delete group",
        run: () => {
          void edit(
            () => invoke({ type: "tagGroup:delete", group: group.id }),
            `Deleted the group ${group.name}`,
          ).then((refused) => refused !== undefined && onProblem(refused));
        },
      });
    },
    [edit, onConfirm, onProblem],
  );

  const one = chosen.length === 1 ? held.tags.find((tag) => tag.name === chosen[0]) : undefined;

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Each key handled here is stopped, so the window's own shortcuts — which
    // act on the grid's selection — never hear it (`App.tsx`).
    const stop = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Delete" && chosen.length > 0) {
      stop();
      deleteChosen(chosen);
    } else if (event.key === "F2" && one !== undefined) {
      stop();
      setNaming({ kind: "rename-tag", from: one.name });
    } else if (event.key === "Enter" && one !== undefined) {
      stop();
      onShowAssets(one.query);
    } else if (event.key === "Escape" && chosen.length > 0) {
      stop();
      setChosen([]);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      stop();
      setChosen(shown.map((tag) => tag.name));
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      stop();
      const at = shown.findIndex((tag) => tag.name === (anchor.current ?? chosen[0]));
      const next =
        shown[Math.max(0, Math.min(shown.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next !== undefined) choose(next.name, { add: false, range: event.shiftKey });
    }
  };

  const placeName =
    place === "all" ? "All tags" : place === "none" ? "Ungrouped" : (groups.get(place)?.name ?? "");
  const ungrouped = held.tags.filter((tag) => tag.group === null).length;

  return (
    <section className="tags-page" aria-label="Tags">
      <header className="bar">
        {lead}
        <h2 className="bar-title">Tags</h2>
        <input
          type="search"
          className="tags-search"
          aria-label="Search tags"
          placeholder="Search tags"
          spellCheck={false}
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
        />
        <div className="filter-rule-choices tags-order">
          {(["name", "count"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="filter-rule-button"
              aria-label={`Order: ${candidate === "name" ? "Name" : "Most used"}`}
              aria-pressed={order === candidate}
              data-on={order === candidate ? "" : undefined}
              onClick={() => setOrder(candidate)}
            >
              {candidate === "name" ? "Name" : "Most used"}
            </button>
          ))}
        </div>
        <div className="bar-actions">
          <button type="button" onClick={() => setNaming({ kind: "new-tag" })}>
            + New tag
          </button>
        </div>
      </header>

      <div className="tags-body">
        <nav className="tags-groups" aria-label="Tag groups">
          <ul className="sidebar-list">
            <GroupRow
              label="All tags"
              count={held.tags.length}
              hue={null}
              current={place === "all"}
              onPick={() => setPlace("all")}
            />
            <GroupRow
              label="Ungrouped"
              count={ungrouped}
              hue={null}
              current={place === "none"}
              onPick={() => setPlace("none")}
              onDropTags={(names) => moveTo(names, null)}
            />
            {held.groups.map((group) => (
              <ContextMenu.Root key={group.id}>
                <ContextMenu.Trigger asChild>
                  <div className="tags-group-row">
                    <GroupRow
                      label={group.name}
                      count={group.tags}
                      hue={hueOf(group.id)}
                      current={place === group.id}
                      onPick={() => setPlace(group.id)}
                      onDropTags={(names) => moveTo(names, group.id)}
                    />
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content
                    className="menu"
                    collisionPadding={8}
                    onCloseAutoFocus={closeAutoFocus}
                  >
                    <ContextMenu.Item
                      className="menu-item"
                      onSelect={handingOff(() => setNaming({ kind: "rename-group", group }))}
                    >
                      <span className="menu-mark" />
                      <span className="menu-label">Rename…</span>
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className="menu-item"
                      onSelect={handingOff(() => deleteGroup(group))}
                    >
                      <span className="menu-mark" />
                      <span className="menu-label">Delete…</span>
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            ))}
          </ul>
          <button
            type="button"
            className="tags-new-group"
            onClick={() => setNaming({ kind: "new-group", moving: [] })}
          >
            + New group
          </button>
        </nav>

        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div
              ref={listbox}
              className="tags-list"
              role="listbox"
              aria-label={placeName}
              aria-multiselectable="true"
              tabIndex={0}
              onKeyDown={onKeyDown}
            >
              {list === undefined ? null : shown.length === 0 ? (
                <p className="tags-empty">
                  {needle.trim() !== ""
                    ? "No tag matches"
                    : held.tags.length === 0
                      ? "No tags yet. A tag added to a file, or made with + New tag, appears here."
                      : place === "none"
                        ? "Every tag is in a group"
                        : "No tags in this group. Drag tags onto it, or use Move to group."}
                </p>
              ) : (
                shown.map((tag) => (
                  <TagRow
                    key={tag.name}
                    tag={tag}
                    groupName={
                      place === "all" && tag.group !== null
                        ? (groups.get(tag.group)?.name ?? null)
                        : null
                    }
                    hue={tag.group === null ? null : hueOf(tag.group)}
                    on={chosen.includes(tag.name)}
                    onChoose={choose}
                    onOpen={onShowAssets}
                    dragged={chosen}
                    listbox={listbox}
                  />
                ))
              )}
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              className="menu"
              collisionPadding={8}
              onCloseAutoFocus={closeAutoFocus}
            >
              <ContextMenu.Item
                className="menu-item"
                disabled={one === undefined}
                onSelect={handingOff(() => one !== undefined && onShowAssets(one.query))}
              >
                <span className="menu-mark" />
                <span className="menu-label">Show assets</span>
              </ContextMenu.Item>
              <ContextMenu.Item
                className="menu-item"
                disabled={one === undefined}
                onSelect={handingOff(
                  () => one !== undefined && setNaming({ kind: "rename-tag", from: one.name }),
                )}
              >
                <span className="menu-mark" />
                <span className="menu-label">Rename…</span>
              </ContextMenu.Item>
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className="menu-item" disabled={chosen.length === 0}>
                  <span className="menu-mark" />
                  <span className="menu-label">Move to group</span>
                  <span className="menu-arrow" aria-hidden="true">
                    ›
                  </span>
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className="menu" sideOffset={2} collisionPadding={8}>
                    {held.groups.map((group) => (
                      <ContextMenu.Item
                        key={group.id}
                        className="menu-item"
                        onSelect={() => moveTo(chosen, group.id)}
                      >
                        <span className="menu-mark">
                          <span className="tag-dot" data-hue={hueOf(group.id)} />
                        </span>
                        <span className="menu-label">{group.name}</span>
                      </ContextMenu.Item>
                    ))}
                    <ContextMenu.Item className="menu-item" onSelect={() => moveTo(chosen, null)}>
                      <span className="menu-mark" />
                      <span className="menu-label">No group</span>
                    </ContextMenu.Item>
                    <ContextMenu.Separator className="menu-separator" />
                    <ContextMenu.Item
                      className="menu-item"
                      onSelect={handingOff(() => setNaming({ kind: "new-group", moving: chosen }))}
                    >
                      <span className="menu-mark" />
                      <span className="menu-label">New group…</span>
                    </ContextMenu.Item>
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
              <ContextMenu.Separator className="menu-separator" />
              <ContextMenu.Item
                className="menu-item"
                disabled={chosen.length === 0}
                onSelect={handingOff(() => deleteChosen(chosen))}
              >
                <span className="menu-mark" />
                <span className="menu-label">Delete…</span>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </div>

      {naming !== undefined && (
        <Naming
          naming={naming}
          tags={held.tags}
          place={place}
          groups={groups}
          edit={edit}
          onDone={(madeGroup) => {
            if (naming.kind === "new-group" && madeGroup !== undefined) {
              if (naming.moving.length > 0) moveTo(naming.moving, madeGroup);
              else {
                awaiting.current = madeGroup;
                setPlace(madeGroup);
              }
            }
            setNaming(undefined);
          }}
          onClose={() => setNaming(undefined)}
        />
      )}
    </section>
  );
}

/** The dialog for whichever name is being asked for. */
function Naming({
  naming,
  tags,
  place,
  groups,
  edit,
  onDone,
  onClose,
}: {
  readonly naming: Naming;
  readonly tags: readonly WireTagEntry[];
  readonly place: Place;
  readonly groups: ReadonlyMap<number, WireTagGroup>;
  readonly edit: (
    run: () => ReturnType<typeof invoke>,
    line: string,
  ) => Promise<WireProblem | undefined>;
  /** The group made, when the dialog made one. */
  readonly onDone: (madeGroup?: number) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const finish =
    (made?: number) =>
    (refused: WireProblem | undefined): WireProblem | undefined => {
      if (refused === undefined) onDone(made);
      return refused;
    };

  if (naming.kind === "new-tag") {
    const group = typeof place === "number" ? place : null;
    const into = group === null ? undefined : groups.get(group)?.name;
    return (
      <NameDialog
        title="New tag"
        description={
          into === undefined
            ? "A tag nothing carries yet, in no group."
            : `A tag nothing carries yet, in ${into}.`
        }
        placeholder="olahraga"
        confirmLabel={() => "Create"}
        onSave={(name) =>
          edit(() => invoke({ type: "tag:create", name, group }), `Made the tag ${name}`).then(
            finish(),
          )
        }
        onClose={onClose}
      />
    );
  }

  if (naming.kind === "rename-tag") {
    const { from } = naming;
    // A rename onto another tag's name merges the two (`OPS.md`), so the
    // button says so before it is pressed rather than the note after.
    const into = (name: string) =>
      tags.find(
        (tag) =>
          tag.name.toLowerCase() === name.toLowerCase() &&
          tag.name.toLowerCase() !== from.toLowerCase(),
      );
    return (
      <NameDialog
        title="Rename tag"
        description="Every asset that carries it carries the new name."
        initial={from}
        placeholder={from}
        confirmLabel={(name) => (into(name) === undefined ? "Rename" : "Merge")}
        hint={(name) => {
          const target = into(name);
          return target === undefined
            ? undefined
            : `${target.name} already exists. The two become one tag, carried by every asset either was on.`;
        }}
        onSave={(name) =>
          edit(
            () => invoke({ type: "tag:rename", from, to: name }),
            into(name) === undefined ? `Renamed ${from} to ${name}` : `Merged ${from} into ${name}`,
          ).then(finish())
        }
        onClose={onClose}
      />
    );
  }

  if (naming.kind === "rename-group") {
    const { group } = naming;
    return (
      <NameDialog
        title="Rename group"
        description="The tags in it stay where they are; only the group's name changes."
        initial={group.name}
        placeholder={group.name}
        confirmLabel={() => "Rename"}
        onSave={(name) =>
          edit(
            () => invoke({ type: "tagGroup:rename", group: group.id, name }),
            `Renamed the group ${group.name} to ${name}`,
          ).then(finish())
        }
        onClose={onClose}
      />
    );
  }

  return (
    <NameDialog
      title="New group"
      description={
        naming.moving.length === 0
          ? "A group arranges tags. It does not change what a tag finds."
          : `${tagsNamed(naming.moving)} will go into it.`
      }
      placeholder="Materials"
      confirmLabel={() => "Create"}
      onSave={async (name) => {
        const made = await invoke({ type: "tagGroup:create", name });
        if (!made.ok) return made.problem;
        finish(made.value)(undefined);
        return undefined;
      }}
      onClose={onClose}
    />
  );
}

/** One group on the left: chosen, counted, and a place to drop tags. */
function GroupRow({
  label,
  count,
  hue,
  current,
  onPick,
  onDropTags,
}: {
  readonly label: string;
  readonly count: number;
  readonly hue: number | null;
  readonly current: boolean;
  readonly onPick: () => void;
  /** Absent on *All tags*, which is not somewhere a tag can be put. */
  readonly onDropTags?: (names: readonly string[]) => void;
}): React.JSX.Element {
  const [over, setOver] = useState(false);
  const accepts = (event: React.DragEvent): boolean =>
    onDropTags !== undefined && event.dataTransfer.types.includes(TAG_DRAG_TYPE);
  return (
    <li>
      <button
        type="button"
        className="sidebar-row"
        data-current={current || undefined}
        aria-current={current ? "true" : undefined}
        data-drop={over || undefined}
        onClick={onPick}
        onDragOver={(event) => {
          if (!accepts(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          setOver(false);
          if (!accepts(event)) return;
          event.preventDefault();
          const names = readDragged(event.dataTransfer.getData(TAG_DRAG_TYPE));
          if (names.length > 0) onDropTags?.(names);
        }}
      >
        <span className="tag-dot" data-hue={hue ?? undefined} aria-hidden="true" />
        <span className="sidebar-label">{label}</span>
        <span className="sidebar-count">{counted(count)}</span>
      </button>
    </li>
  );
}

/**
 * One tag. Memo'd on what it draws, for the reason the sidebar's rows are: a
 * library of two thousand tags redraws every one of them on any change, and a
 * tick changes one.
 */
const TagRow = memo(function TagRow({
  tag,
  groupName,
  hue,
  on,
  onChoose,
  onOpen,
  dragged,
  listbox,
}: {
  readonly tag: WireTagEntry;
  /** Drawn only on *All tags*, where the group is not already the heading. */
  readonly groupName: string | null;
  readonly hue: number | null;
  readonly on: boolean;
  readonly onChoose: (
    name: string,
    how: { readonly add: boolean; readonly range: boolean },
  ) => void;
  readonly onOpen: (query: string) => void;
  /** What a drag from a chosen row carries: every chosen tag. */
  readonly dragged: readonly string[];
  readonly listbox: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  return (
    <div
      className="tags-row"
      role="option"
      // Focus stays on the list, which carries the keys; a row is reached by
      // the pointer and by the arrows the list handles.
      tabIndex={-1}
      aria-selected={on}
      data-on={on || undefined}
      draggable
      onMouseDown={(event) => {
        if (event.button === 2) {
          // A right-click on a tag that is not chosen chooses it alone, as a
          // file manager does, so the menu is about the row under the pointer.
          if (!on) onChoose(tag.name, { add: false, range: false });
          return;
        }
        if (event.button !== 0) return;
        onChoose(tag.name, { add: event.ctrlKey || event.metaKey, range: event.shiftKey });
        listbox.current?.focus({ preventScroll: true });
      }}
      onDoubleClick={() => onOpen(tag.query)}
      onDragStart={(event) => {
        const names = on ? dragged : [tag.name];
        if (!on) onChoose(tag.name, { add: false, range: false });
        event.dataTransfer.setData(TAG_DRAG_TYPE, JSON.stringify(names));
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <span className="tag-dot" data-hue={hue ?? undefined} aria-hidden="true" />
      <span className="tags-name">{tag.name}</span>
      {groupName !== null && <span className="tags-group-name">{groupName}</span>}
      <span className="sidebar-count">{counted(tag.count)}</span>
    </div>
  );
});

/**
 * A group's colour, derived from its id and never stored (ADR-0061 §2): one of
 * the eight `--tag-hue-*` tokens, so the same group is the same colour in every
 * window and every session.
 */
function hueOf(group: number): number {
  return ((group - 1) % 8) + 1;
}

/** The names a drag carried, or none for anything that is not a list of strings. */
function readDragged(data: string): string[] {
  try {
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function tagsNamed(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? "") : `${names.length} tags`;
}

function assetsCount(count: number): string {
  return count === 1 ? "1 asset" : `${counted(count)} assets`;
}
