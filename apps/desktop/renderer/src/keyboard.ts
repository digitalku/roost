/**
 * What a window-level shortcut has to know before it fires.
 *
 * Shared because the rule is one rule: a shortcut listens on `window`, so it
 * hears every keystroke in the window, including the ones somebody meant for a
 * field they are typing into.
 */

/** Whether a keystroke belongs to whatever the user is typing into. */
export function isTyping(element: HTMLElement): boolean {
  return (
    element.isContentEditable ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  );
}
