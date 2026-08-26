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
