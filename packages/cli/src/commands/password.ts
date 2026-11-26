import { EmptyPasswordError } from "@roost/library";
import { EXIT, type Streams } from "../io.js";
import { askPassword, openLibrary, passwordToOpen } from "../open.js";

export const PASSWORD_ACTIONS = ["set", "change", "remove"] as const;
export type PasswordAction = (typeof PASSWORD_ACTIONS)[number];

export function isPasswordAction(value: string): value is PasswordAction {
  return (PASSWORD_ACTIONS as readonly string[]).includes(value);
}

/**
 * `roost password set|change|remove` (ADR-0071 §3.4).
 *
 * The current password opens the library and is then given back to it as the
 * proof that changing the password is allowed, which is what the window asks
 * for too. A new password is asked for twice, and from `ROOST_NEW_PASSWORD`
 * both answers are that variable.
 */
export async function password(
  root: string,
  action: PasswordAction,
  streams: Streams,
): Promise<number> {
  const current = await passwordToOpen(root, "library");
  const library = await openLibrary(root);
  try {
    if (action === "set" && library.hasPassword) {
      streams.warn("This library already has a password. Use `roost password change`.");
      return EXIT.failed;
    }
    if (action !== "set" && !library.hasPassword) {
      streams.warn("This library has no password.");
      return EXIT.failed;
    }

    let next: string | null = null;
    if (action !== "remove") {
      const typed = await askPassword("new", root);
      if (typed === undefined || typed === "") throw new EmptyPasswordError();
      const again = await askPassword("again", root);
      if (again !== typed) {
        streams.warn("The two do not match. Nothing was changed.");
        return EXIT.failed;
      }
      next = typed;
    }

    await library.changePassword(current, next);
    streams.out(
      next === null
        ? "Removed the password. Any Roost opens this library without asking."
        : "Set the password. Roost asks for it before opening this library; it encrypts nothing, and a Roost older than this one cannot open it.",
    );
    return EXIT.ok;
  } finally {
    await library.close();
  }
}
