import MarkdownIt from "markdown-it";

/**
 * Markdown, rendered for the pane (ADR-0070 §3.3).
 *
 * **`html: false`**: raw HTML in a file is escaped and shown as text, so nothing
 * a file says can put an element or a script into the window (invariant 11).
 * `markdown-it` also refuses `javascript:`, `vbscript:`, `file:` and `data:`
 * links by itself.
 *
 * **Images are not drawn.** A remote one would be the network (invariant 7, and
 * the CSP would refuse it anyway), and a relative one names a path beside a file
 * that lives at `files/<sh>/<id>.md`, where nothing is. Each shows its alt text.
 *
 * Links are left as links and followed by the pane, which hands an `http(s)`
 * one to the system's browser (`link:open`) and nothing else anywhere.
 */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });

markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const alt =
    token === undefined ? "" : markdown.renderer.renderInlineAsText(token.children ?? [], {}, {});
  return `<span class="markdown-image" title="Images in a Markdown file are not drawn">${markdown.utils.escapeHtml(alt === "" ? "image" : alt)}</span>`;
};

/**
 * Each block says which source line it began on, so a click on it can put the
 * editor's caret there (ADR-0070 §8.1).
 */
markdown.core.ruler.push("source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.map !== null && token.nesting !== -1 && token.block) {
      token.attrSet("data-source-line", String(token.map[0]));
    }
  }
  return true;
});

/** The HTML the pane draws for a Markdown file's text. */
export function renderMarkdown(text: string): string {
  return markdown.render(text);
}

/**
 * The link a click in rendered Markdown landed on, if it is one to follow:
 * `http(s)` only, as a source URL is (ADR-0030).
 */
export function followableLink(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const anchor = target.closest("a");
  const href = anchor?.getAttribute("href");
  if (href === null || href === undefined) return undefined;
  return /^https?:\/\//i.test(href) ? href : undefined;
}
