import { quoteValue } from "@roost/search";
import type { Library } from "./library.js";

/** One tag group, and how many tags it holds (ADR-0061). */
export interface TagGroupEntry {
  readonly id: number;
  readonly name: string;
  readonly tags: number;
}

/** One tag, its group by id, and how many live assets carry it (ADR-0061). */
export interface TagListEntry {
  readonly name: string;
  /** The query that shows what carries it, written here so no frontend writes RQL. */
  readonly query: string;
  readonly group: number | null;
  readonly count: number;
}

/** Everything the tags page draws (ADR-0061). */
export interface TagList {
  readonly groups: TagGroupEntry[];
  readonly tags: TagListEntry[];
}

/**
 * Every tag and every tag group, for the page that arranges them (ADR-0061).
 *
 * Groups by id rather than by name: since schema v3 two may share a name the
 * journal gave them, and an edit from the page has to say which one it means.
 * Both lists alphabetical; a group's count is of its tags, which is what the
 * page's left column says, not of the assets they are on.
 */
export function readTagList(library: Library): TagList {
  const repo = library.db.repo;
  const tags = repo.tagList().map((tag) => ({
    name: tag.name,
    query: `tag:${quoteValue(tag.name)}`,
    group: tag.groupId,
    count: tag.count,
  }));
  const held = new Map<number, number>();
  for (const tag of tags) {
    if (tag.group !== null) held.set(tag.group, (held.get(tag.group) ?? 0) + 1);
  }
  const groups = repo
    .tagGroups()
    .map((group) => ({ id: group.id, name: group.name, tags: held.get(group.id) ?? 0 }));
  return { groups, tags };
}
