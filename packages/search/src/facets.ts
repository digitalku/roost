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
 * What the bar selects, as data rather than as a query.
 *
 * Within a facet the values are `OR`ed and across facets they are `AND`ed,
 * which is what every filter bar means and the only thing two ratings can
 * mean together.
 */
export interface Facets {
  /** Tag names, as the library spells them. */
  readonly tags: readonly string[];
  /** Star counts. Unrated is **not** a rating of zero; see {@link unrated}. */
  readonly stars: readonly Stars[];
  /** `is:unrated`, which sits in the rating facet without being a rating. */
  readonly unrated: boolean;
  /** Extensions, lowercased and without a dot, as the schema stores them. */
  readonly exts: readonly string[];
}

export const NO_FACETS: Facets = { tags: [], stars: [], unrated: false, exts: [] };

/** A query, read as somewhere to look plus what the bar has narrowed it to. */
export interface SplitQuery {
  /**
   * Everything the bar does not own, in the words it was written in: typed
   * text, `folder:`, `is:trashed`, `size:>2mb`, a negated tag.
   */
  readonly place: string;
  readonly facets: Facets;
  /**
   * Whether the bar can show this query honestly.
   *
   * False for a query whose facets it cannot represent — a top-level `OR`, or
   * two separate tag terms, which mean `AND` where the bar can only mean `OR`.
   * Nothing is absorbed then: the whole query is the place, every chip is off,
   * and choosing one **adds** to the query rather than claiming to own it.
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
    return { place: input.trim(), facets: NO_FACETS, representable: false };
  }

  const claimed = conjuncts.map((slice) => ({ slice, claim: facetOf(slice) }));

  // A second conjunct for one facet is an `AND` where the bar can only say
  // `OR`. Absorbing both would ask a different question, so a doubled facet is
  // absorbed nowhere — counted first, so the decision is the same for the
  // conjunct that came before the clash and the one that caused it.
  const claims = new Map<FacetKind, number>();
  for (const { claim } of claimed) {
    if (claim !== undefined) claims.set(claim.kind, (claims.get(claim.kind) ?? 0) + 1);
  }
  const doubled = [...claims].some(([, count]) => count > 1);

  const owned = new Map<FacetKind, Values>();
  const place: string[] = [];
  for (const { slice, claim } of claimed) {
    if (claim === undefined || (claims.get(claim.kind) ?? 0) > 1) {
      place.push(slice);
      continue;
    }
    owned.set(claim.kind, claim.values);
  }

  const tags = owned.get("tags")?.tags ?? [];
  const rating = owned.get("rating");
  const exts = owned.get("exts")?.exts ?? [];

  return {
    // The kept slices in the order they were written; a conjunct the bar
    // absorbed simply is not there any more.
    place: place.join(" "),
    facets: {
      tags,
      stars: rating?.stars ?? [],
      unrated: rating?.unrated ?? false,
      exts,
    },
    representable: !doubled,
  };
}

/**
 * Puts a place and a set of facets back together.
 *
 * The place first, in the words it came in, then the facets in a fixed order —
 * so turning a filter off and on again returns the query it started from rather
 * than the same terms in a new arrangement.
 */
export function joinQuery(place: string, facets: Facets): string {
  const terms = [tagTerm(facets), ratingTerm(facets), extTerm(facets)].filter(
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

/** `tag:wood`, or `(tag:wood OR tag:metal)`, or nothing at all. */
function tagTerm(facets: Facets): string | undefined {
  return orOf(facets.tags.map((tag) => `tag:${quoteValue(tag)}`));
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
