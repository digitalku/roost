/**
 * Fail the build on a `var(--token)` that nothing declares.
 *
 * CSS has no undefined-variable error. A typo'd token makes the browser drop
 * the whole declaration silently — in the Rust implementation, exactly one such
 * typo left the preview pane fully transparent while it was still covering the
 * grid, so every thumbnail behind it showed through the picture that had been
 * opened. TypeScript could not see it, no test touched it, and it took a
 * screenshot from a person to find. This check is what sees it now.
 *
 * `docs/UI_SPEC.md` §2 is the rule this enforces: every token is declared in
 * one place, and components use semantic tokens rather than raw ramp steps.
 */

import { glob, readFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const DECLARATION = /(--[\w-]+)\s*:/g;
const USAGE = /var\(\s*(--[\w-]+)/g;

/**
 * Comments are removed before anything is scanned. Without this, the comment
 * explaining a token bug would report itself as a bug.
 *
 * @param {string} css
 * @returns {string}
 */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * @param {string} css
 * @returns {{ declared: Set<string>, used: Set<string> }}
 */
export function collectTokens(css) {
  const source = stripComments(css);
  const declared = new Set([...source.matchAll(DECLARATION)].map((m) => m[1]));
  const used = new Set([...source.matchAll(USAGE)].map((m) => m[1]));
  return { declared, used };
}

/**
 * A token used with a fallback — `var(--x, 4px)` — is still reported. A
 * fallback hides the symptom without making the token real, and this codebase
 * declares every token in one file rather than relying on them.
 *
 * @param {string} css
 * @returns {string[]} the undeclared tokens, sorted
 */
export function findUndeclaredTokens(css) {
  const { declared, used } = collectTokens(css);
  return [...used].filter((token) => !declared.has(token)).sort();
}

async function main() {
  const patterns = argv.slice(2);
  if (patterns.length === 0) {
    console.error("usage: check-css-tokens <glob> [glob...]");
    exit(2);
  }

  /** @type {string[]} */
  const files = [];
  for (const pattern of patterns) {
    for await (const file of glob(pattern)) files.push(file);
  }

  if (files.length === 0) {
    // No stylesheets yet. The check is deliberately in place before the first
    // component rather than after the first bug (`docs/TODO.md` §4).
    return;
  }

  // Tokens are declared in one file and used across many, so the whole set is
  // scanned as one document. Checking file by file would report every usage in
  // every component as undeclared.
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const undeclared = findUndeclaredTokens(sources.join("\n"));

  if (undeclared.length > 0) {
    console.error(
      `Undeclared CSS custom ${undeclared.length === 1 ? "property" : "properties"}:\n` +
        undeclared.map((token) => `  ${token}`).join("\n") +
        `\n\nCSS drops a declaration that references an undefined variable, silently.` +
        `\nDeclare it in the token file, or fix the spelling. See docs/UI_SPEC.md §2.`,
    );
    exit(1);
  }
}

// Only run when invoked as a program, so the tests can import the functions.
if (import.meta.filename === argv[1]) await main();
