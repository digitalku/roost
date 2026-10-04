import type { Expr } from "./ast.js";
import { type Token, tokenize } from "./lexer.js";
import { parse } from "./parser.js";
import { quoteValue } from "./quote.js";

/**
 * Reading a query as a place plus three filters, and writing one back
 * (ADR-0035).
 *
 * The filter bar over the grid is a **view of the query**, not a second piece
 * of state — so something has to be able to say what a query currently selects
 * and to hand back a new query with one facet changed. It cannot be the
 * renderer: the grammar has one implementation and the sandbox is not the place
 * for a second (`UI_SPEC.md` §4.1).
 *
 * It also cannot be done by reprinting the tree. `Expr` holds values that are
 * **already normalised** — sizes in bytes, dates in unix seconds — so parsing
 * `size:>2mb created:2024-03-01` and printing it back returns
 * `size:>2097152 created:1709251200..1709337599`, which is the same question
 * asked in words nobody typed. So everything this file does not own is carried
 * as a **slice of the source**, byte for byte, and only the facets are printed.
 */

/** A rating a facet can select: one to five stars. */
export type Stars = 1 | 2 | 3 | 4 | 5;

/**
 * How several values in the tag facet are joined (ADR-0035 §7).
 *
 * `any` is `(tag:a OR tag:b)` and `all` is `tag:a tag:b` — two shapes the
 * splitter already had to tell apart, which is why the rule needs nothing added
 * to the grammar.
 *
 * **Only tags have one, and the data decides that.** An asset has one extension
 * and one rating, so `all` on those two facets would be a button whose only
 * outcome is an empty grid.
 */
export type TagRule = "any" | "all";

/**
 * What the bar selects, as data rather than as a query.
 *
 * Within a facet the values are `OR`ed and across facets they are `AND`ed,
 * which is what every filter bar means and the only thing two ratings can
 * mean together.
 */
export interface Facets {
  /** Tag names, as the library spells them. */
  readonly tags: readonly string[];
  /**
   * Whether the tags are `OR`ed or `AND`ed.
   *
   * Meaningless below two tags, where both rules spell the same query — the
   * window remembers the choice there, and this says `any` (ADR-0035 §7.2).
   */
  readonly tagRule: TagRule;
  /** Star counts. Unrated is **not** a rating of zero; see {@link unrated}. */
  readonly stars: readonly Stars[];
  /** `is:unrated`, which sits in the rating facet without being a rating. */
  readonly unrated: boolean;
  /** Extensions, lowercased and without a dot, as the schema stores them. */
  readonly exts: readonly string[];
}

export const NO_FACETS: Facets = {
  tags: [],
  tagRule: "any",
  stars: [],
  unrated: false,
  exts: [],
};

/** A query, read as somewhere to look plus what the bar has narrowed it to. */
export interface SplitQuery {
  /**
   * Everything the bar does not own, in the words it was written in: typed
   * text, `folder:`, `is:trashed`, `size:>2mb`, a negated tag.
   */
  readonly place: string;
  readonly facets: Facets;
  /**
   * Whether the query on screen reaches into subfolders (ADR-0036).
   *
   * `true` for a `folder:` conjunct, `false` for an `infolder:` one, and
   * **`null` when the query names no folder at all** — the checkbox has nothing
   * to reflect then, and shows the library's setting, which is what the next
   * folder opened will use.
   *
   * Also `null` for two folder conjuncts, for the same reason two ratings are
   * refused: the answer would be two answers.
   */
  readonly subfolders: boolean | null;
  /**
   * Whether the bar can show this query honestly.
   *
   * False for a query whose facets it cannot represent — a top-level `OR`, two
   * ratings, two extensions, or a tag facet that is partly an `OR` and partly
   * an `AND`. Nothing is absorbed then: the whole query is the place, every
   * chip is off, and choosing one **adds** to the query rather than claiming to
   * own it.
   *
   * Two plain tag terms are **not** among them since 2026-09-08: `tag:a tag:b`
   * is what the `all` rule spells (ADR-0035 §7).
   */
  readonly representable: boolean;
}

/** Which facet a conjunct belongs to, if any. */
type FacetKind = "tags" | "rating" | "exts";

/**
 * Splits a query into the place it looks and the facets that narrow it.
 *
 * Never throws. A query that does not parse is entirely a place: the grid is
 * already saying so, and a filter bar is not the control that should raise it.
 */
export function splitQuery(input: string): SplitQuery {
  const conjuncts = topLevelConjuncts(input);
  if (conjuncts === undefined) {
    return { place: input.trim(), facets: NO_FACETS, subfolders: null, representable: false };
  }

  const claimed = conjuncts.map((slice) => ({ slice, claim: facetOf(slice) }));

  const claims = new Map<FacetKind, { readonly values: Values }[]>();
  for (const { claim } of claimed) {
    if (claim === undefined) continue;
    const held = claims.get(claim.kind);
    if (held === undefined) claims.set(claim.kind, [claim]);
    else held.push(claim);
  }

  /*
   * Several conjuncts of one facet.
   *
   * For tags that is the `all` rule and the whole of ADR-0035 §7: `tag:a tag:b`
   * asks for both, which is a thing the bar can now say. It has to be plain
   * terms all the way down, though — `(tag:a OR tag:b) tag:c` mixes the two
   * rules and belongs to neither.
   *
   * For ratings and extensions it stays what §2 made it: an asset has one of
   * each, so two conjuncts match nothing, and a bar that drew them as chosen
   * would be describing an empty grid as a filter.
   */
  const tagClaims = claims.get("tags") ?? [];
  const tagRule: TagRule = tagClaims.length > 1 ? "all" : "any";
  const tagsAreAll = tagClaims.every((claim) => claim.values.tags.length === 1);
  const refused = new Set<FacetKind>();
  for (const [kind, held] of claims) {
    if (held.length < 2) continue;
    if (kind !== "tags" || !tagsAreAll) refused.add(kind);
  }

  const owned = new Map<FacetKind, Values[]>();
  const place: string[] = [];
  for (const { slice, claim } of claimed) {
    if (claim === undefined || refused.has(claim.kind)) {
      place.push(slice);
      continue;
    }
    const held = owned.get(claim.kind);
    if (held === undefined) owned.set(claim.kind, [claim.values]);
    else held.push(claim.values);
  }

  const tags = (owned.get("tags") ?? []).flatMap((values) => values.tags);
  const rating = owned.get("rating")?.[0];
  const exts = owned.get("exts")?.[0]?.exts ?? [];

  // Read off the place rather than absorbed out of it. A folder is where you
  // are looking, not a filter over it (ADR-0035 §6), so the term stays in the
  // words it was written in and the checkbox only says what depth it names.
  const depths = place.map(folderTerm).filter((term) => term !== undefined);
  const [depth] = depths;

  return {
    // The kept slices in the order they were written; a conjunct the bar
    // absorbed simply is not there any more.
    place: place.join(" "),
    facets: {
      tags,
      tagRule,
      stars: rating?.stars ?? [],
      unrated: rating?.unrated ?? false,
      exts,
    },
    subfolders: depths.length === 1 && depth !== undefined ? depth.field === "folder" : null,
    representable: refused.size === 0,
  };
}

/**
 * Rewrites the folder a query names to the other depth (ADR-0036).
 *
 * The whole of *Show subfolder contents* as far as a query on screen is
 * concerned: `folder:Design` becomes `infolder:Design` and back. A query naming
 * no folder is returned **unchanged and identical** — the checkbox is then a
 * setting for the next folder opened, and rewriting nothing must not reformat
 * what somebody typed.
 *
 * The term is reprinted rather than patched byte-for-byte, because the value
 * has to come back out through `quoteValue` to survive a path with a space in
 * it — and that is the one printer the grammar has.
 */
export function withSubfolders(query: string, on: boolean): string {
  const conjuncts = topLevelConjuncts(query);
  if (conjuncts === undefined) return query;

  const wanted = on ? "folder" : "infolder";
  let changed = false;
  const rewritten = conjuncts.map((slice) => {
    const term = folderTerm(slice);
    if (term === undefined || term.field === wanted) return slice;
    changed = true;
    return `${wanted}:${quoteValue(term.value)}`;
  });
  return changed ? rewritten.join(" ") : query;
}

/** A query reaching into subfolders, read as the two parts the grid draws in turn. */
export interface SubfolderSections {
  /** The folder's own assets: the query with `folder:` turned to `infolder:`. */
  readonly own: string;
  /** The rest of the subtree: the query with the folder's own assets taken out. */
  readonly beneath: string;
}

/**
 * Splits a query that shows a folder's subfolders into the folder's own assets
 * and then everything beneath it (ADR-0059), or `undefined` for any other.
 *
 * Only a query with **one** `folder:` among its top-level terms is split: that
 * is what *Show subfolder contents* writes, with or without the filter bar's
 * terms beside it. Each part is an ordinary query, so each is paged by the same
 * index the whole would have been, and an asset both in the folder and beneath
 * it is in the first part only.
 */
export function subfolderSections(query: string): SubfolderSections | undefined {
  const conjuncts = topLevelConjuncts(query);
  if (conjuncts === undefined) return undefined;
  const folders = conjuncts.map(folderTerm).filter((term) => term !== undefined);
  const [folder] = folders;
  if (folders.length !== 1 || folder === undefined || folder.field !== "folder") return undefined;
  return {
    own: withSubfolders(query, false),
    // Appended rather than placed: there is no top-level `OR` here, or there
    // would have been no conjuncts, so one more term narrows all of it.
    beneath: `${conjuncts.join(" ")} -infolder:${quoteValue(folder.value)}`,
  };
}

/** A conjunct that is one plain folder term, at whichever depth it names. */
function folderTerm(
  slice: string,
): { readonly field: "folder" | "infolder"; readonly value: string } | undefined {
  let expr: Expr;
  try {
    expr = parse(slice);
  } catch {
    return undefined;
  }
  // One bare term only. `-folder:x` and `(folder:a OR folder:b)` are questions
  // the checkbox has no answer for, and quietly rewriting either would change
  // what was asked.
  if (expr.kind !== "term") return undefined;
  const { term } = expr;
  if (term.field !== "folder" && term.field !== "infolder") return undefined;
  return { field: term.field, value: term.value };
}

/**
 * Puts a place and a set of facets back together.
 *
 * The place first, in the words it came in, then the facets in a fixed order —
 * so turning a filter off and on again returns the query it started from rather
 * than the same terms in a new arrangement.
 */
export function joinQuery(place: string, facets: Facets): string {
  const terms = [...tagTerms(facets), ratingTerm(facets), extTerm(facets)].filter(
    (term): term is string => term !== undefined,
  );
  const trimmed = place.trim();
  if (terms.length === 0) return trimmed;
  if (trimmed === "") return terms.join(" ");
  // `a OR b` followed by a term would parse as `a OR (b AND term)`: an `OR` the
  // bar could not read is exactly the one that has to be fenced off before
  // anything is `AND`ed onto it.
  const fenced = topLevelConjuncts(trimmed) === undefined ? `(${trimmed})` : trimmed;
  return [fenced, ...terms].join(" ");
}

/** The values one conjunct contributes. */
interface Values {
  readonly tags: readonly string[];
  readonly stars: readonly Stars[];
  readonly unrated: boolean;
  readonly exts: readonly string[];
}

/**
 * The top-level `AND` conjuncts of a query, as source slices.
 *
 * `undefined` when the query has a top-level `OR`, does not lex, or is empty of
 * terms — none of which can be split into things that are `AND`ed together.
 */
function topLevelConjuncts(input: string): readonly string[] | undefined {
  let tokens: readonly Token[];
  try {
    tokens = tokenize(input);
  } catch {
    return undefined;
  }
  if (tokens.length === 0) return [];

  const slices: string[] = [];
  let depth = 0;
  let start: number | undefined;
  let end = 0;

  for (const token of tokens) {
    if (depth === 0 && token.type === "or") return undefined;

    if (token.type === "open") depth += 1;
    if (token.type === "close") {
      depth -= 1;
      // More closes than opens: the parser will refuse this, and refusing here
      // as well keeps the two from disagreeing about what it means.
      if (depth < 0) return undefined;
    }

    if (depth === 0 && token.type === "and") {
      if (start !== undefined) slices.push(input.slice(start, end));
      start = undefined;
      continue;
    }

    // A conjunct begins at the first token after a boundary and runs until the
    // next one. Inside parentheses nothing is a boundary.
    if (start === undefined) start = token.at;
    end = token.end;

    // A word or a closed group ends a conjunct unless a negation is still
    // open — `-tag:wip` is one conjunct, not two.
    if (depth === 0 && (token.type === "word" || token.type === "close")) {
      slices.push(input.slice(start, end));
      start = undefined;
    }
  }

  if (depth !== 0) return undefined;
  if (start !== undefined) slices.push(input.slice(start, end));
  return slices;
}

/** What facet a conjunct is, or `undefined` if the bar does not own it. */
function facetOf(slice: string): { readonly kind: FacetKind; readonly values: Values } | undefined {
  let expr: Expr;
  try {
    expr = parse(slice);
  } catch {
    return undefined;
  }

  // A conjunct is either one term or an `OR` of them. Anything else — a
  // negation, a nested `AND` — belongs to the place.
  const branches = expr.kind === "or" ? expr.branches : [expr];
  const values: { tags: string[]; stars: Stars[]; unrated: boolean; exts: string[] } = {
    tags: [],
    stars: [],
    unrated: false,
    exts: [],
  };
  const kinds = new Set<FacetKind>();

  for (const branch of branches) {
    if (branch.kind !== "term") return undefined;
    const term = branch.term;

    if (term.field === "tag") {
      kinds.add("tags");
      values.tags.push(term.value);
      continue;
    }
    if (term.field === "ext") {
      kinds.add("exts");
      values.exts.push(term.value);
      continue;
    }
    if (term.field === "rating" && term.compare.op === "eq" && isStars(term.compare.value)) {
      kinds.add("rating");
      values.stars.push(term.compare.value);
      continue;
    }
    // `rating:>=4` is a perfectly good query and not a thing this bar draws:
    // its rows are one rating each (`UI_SPEC.md` §4.1), so a range stays in
    // the place where it can be read.
    if (term.field === "flag" && term.flag === "unrated") {
      kinds.add("rating");
      values.unrated = true;
      continue;
    }
    return undefined;
  }

  // `(tag:wood OR ext:png)` is one term of a query and two facets of a bar,
  // which is a thing the bar cannot draw and must not silently rewrite.
  const [only] = kinds;
  if (kinds.size !== 1 || only === undefined) return undefined;
  return { kind: only, values };
}

function isStars(value: number): value is Stars {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * The tag facet, as one term or as several.
 *
 * `any` is one term — `tag:wood`, or `(tag:wood OR tag:metal)`. `all` is a term
 * each, which is what an `AND` between them looks like written down, and what
 * `splitQuery` reads back as the rule.
 */
function tagTerms(facets: Facets): readonly (string | undefined)[] {
  const written = facets.tags.map((tag) => `tag:${quoteValue(tag)}`);
  return facets.tagRule === "all" ? written : [orOf(written)];
}

function extTerm(facets: Facets): string | undefined {
  return orOf(facets.exts.map((ext) => `ext:${quoteValue(ext)}`));
}

/** Stars descending, then unrated — the order the sidebar drew them in. */
function ratingTerm(facets: Facets): string | undefined {
  const stars = [...new Set(facets.stars)].sort((a, b) => b - a);
  return orOf([
    ...stars.map((count) => `rating:${count}`),
    ...(facets.unrated ? ["is:unrated"] : []),
  ]);
}

function orOf(terms: readonly string[]): string | undefined {
  if (terms.length === 0) return undefined;
  if (terms.length === 1) return terms[0];
  return `(${terms.join(" OR ")})`;
}
