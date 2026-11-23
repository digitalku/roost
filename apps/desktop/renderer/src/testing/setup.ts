import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * The renderer's test harness, in place **before** the components.
 *
 * `roost-old` shipped its first UI milestone with nothing exercising the
 * preview, the context menu, or the dialogs, and the bug that found the gap was
 * invisible to TypeScript and to every test that existed. `TODO.md` marks this
 * as the one thing that must not arrive after the components it covers.
 */

// A component left mounted between tests keeps its effects, its timers, and its
// subscriptions, and the failure surfaces in whichever test runs next.
afterEach(cleanup);

/*
 * No `selectionchange` events in the renderer's tests.
 *
 * happy-dom dispatches one synchronously from within `Selection.collapse`, and
 * it has no layout to answer CodeMirror's reading of the selection with, so the
 * editor (ADR-0070 §8) takes each event as a new selection, sets it, and sets
 * off the next: first *"Calls to EditorView.update are not allowed while an
 * update is in progress"*, then, deferred to a later task, a loop that ran the
 * worker out of memory. Nothing else in the window listens for the event, and
 * the tests drive the editor through its own API; `check-text.mjs` drives it in
 * a real window, where Chromium sends the event as it should.
 */
const dispatch = document.dispatchEvent.bind(document);
// On the document itself: happy-dom's own classes are not the globals a test
// sees, so a patch on `Document.prototype` is never reached.
document.dispatchEvent = (event: Event): boolean =>
  event.type === "selectionchange" ? true : dispatch(event);
