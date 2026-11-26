import { Dialog } from "radix-ui";
import { useState } from "react";

/**
 * Asking for a library's password before it opens (ADR-0071 §3.2).
 *
 * The same question from the picker and from *Move to* or *Copy to* another
 * library, so it says which library it is asking about and nothing about why:
 * the person knows what they just clicked. It keeps nothing it is given. The
 * text goes to `onSubmit` and the field is emptied on a wrong answer, so a
 * second try starts clean rather than with the mistake still in it.
 */
export function PasswordPrompt({
  name,
  wrong,
  busy,
  onSubmit,
  onCancel,
}: {
  /** The library's name, which is its folder's (RL-7b). */
  readonly name: string;
  /** The last answer was not the password. */
  readonly wrong: boolean;
  readonly busy: boolean;
  readonly onSubmit: (password: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState("");
  const ready = password !== "" && !busy;

  const submit = (): void => {
    if (!ready) return;
    const given = password;
    setPassword("");
    onSubmit(given);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title className="dialog-title">{name} has a password</Dialog.Title>
          <Dialog.Description className="dialog-body">
            Type it to open the library.
          </Dialog.Description>

          <label className="field" htmlFor="library-password">
            <span>Password</span>
            <input
              id="library-password"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>

          {wrong && (
            <p className="dialog-problem" role="alert">
              That is not the password.
            </p>
          )}

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button" disabled={busy}>
                Cancel
              </button>
            </Dialog.Close>
            <button type="button" data-variant="primary" disabled={!ready} onClick={submit}>
              {busy ? "Opening…" : "Open"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
