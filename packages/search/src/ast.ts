/**
 * The parsed shape of a query.
 *
 * Values are **already normalised** here — sizes in bytes, dates in unix
 * seconds, durations in milliseconds — so the compiler only has to place them,
 * and every unit and format question is answered in one place.
 */

/** A comparison against a number. Both ends of a range are inclusive. */
export type Compare =
  | { readonly op: "eq" | "lt" | "le" | "gt" | "ge"; readonly value: number }
  | { readonly op: "between"; readonly low: number; readonly high: number };

/** A yes-or-no property of an asset. */
export const FLAGS = [
  "favorite",
  "tagged",
  "untagged",
  "rated",
  "unrated",
  "managed",
  "referenced",
  "partial-hash",
  /**
   * In the trash (ADR-0022).
   *
   * The one flag that changes the *scope* of a query rather than narrowing it:
   * every query is scoped to live assets unless it mentions this one. See
   * `compile.ts`, which is where that happens.
   */
  "trashed",
  /**
   * Replaced by a newer version (ADR-0026).
   *
   * The second flag that changes a query's *scope* rather than narrowing it,
   * and it is independent of the first: `is:trashed` opts out of the trash
   * half and not of this one, because a superseded row in the trash is still a
   * version rather than something somebody deleted.
   */
  "superseded",
  /**
   * Attached as somebody's caption track (ADR-0025).
   *
   * The third flag that changes a query's *scope*. The rule is about
   * **attachment, not format**: an `.srt` imported on its own is an ordinary
   * text asset and appears like one; it leaves the grid at the moment it
   * becomes a caption track, and comes back with this.
   */
  "subtitle",
  /** Has at least one caption track — the question nobody can ask today. */
  "captioned",
] as const;

export type Flag = (typeof FLAGS)[number];

/** Fields whose value is a string compared for equality or membership. */
export const NAME_FIELDS = ["tag", "folder", "group", "ext"] as const;

export type NameField = (typeof NAME_FIELDS)[number];

/** Fields whose value is a number, after units are resolved. */
export const NUMERIC_FIELDS = [
  "size",
  "width",
  "height",
  "duration",
  "rating",
  "created",
  "imported",
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];

/** One condition. */
export type Term =
  /**
   * `tag` is an exact name, compared case-insensitively as the schema does.
   * `folder` is a path such as `Design/Icons`, matching the folder and
   * everything beneath it. `group` reaches an asset through the tags in that
   * group, since a group arranges tags rather than containing assets.
   */
  | { readonly field: NameField; readonly value: string }
  | { readonly field: NumericField; readonly compare: Compare }
  | { readonly field: "flag"; readonly flag: Flag }
  /** Free text, matched against the full-text index over name and tags. */
  | { readonly field: "text"; readonly value: string };

/** A query tree. */
export type Expr =
  | { readonly kind: "all" }
  | { readonly kind: "term"; readonly term: Term }
  | { readonly kind: "not"; readonly expr: Expr }
  | { readonly kind: "and"; readonly branches: readonly Expr[] }
  | { readonly kind: "or"; readonly branches: readonly Expr[] };
