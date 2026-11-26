import type { LibrarySummary, WireProblem } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { invoke } from "../bridge.js";

/** Which of the three `☰` items opened the dialog (ADR-0071 §3.3). */
export type PasswordChange = "set" | "change" | "remove";

const TITLES: Readonly<Record<PasswordChange, string>> = {
  set: "Set a password",
  change: "Change the password",
  remove: "Remove the password",
};

/**
 * Setting, changing or removing the open library's password (ADR-0071 §3.3).
 *
 * One dialog with three shapes rather than three dialogs, because they share
 * every rule: the current password first when there is one, the new one typed
 * twice so that a slip is caught here and not at the next open, and the
 * engine's refusal drawn in the dialog, which stays open. **What it says about
 * the password is the honest part**: it encrypts nothing, and a Roost older
 * than this one cannot open the library at all while it has one (§3.7).
 */
export function PasswordDialog({
  change,
  onClose,
  onChanged,
}: {
  readonly change: PasswordChange;
  readonly onClose: () => void;
  readonly onChanged: (summary: LibrarySummary) => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<WireProblem | undefined>();

  const asksCurrent = change !== "set";
  const asksNext = change !== "remove";
  const mismatch = asksNext && again !== "" && next !== again;
  const ready =
    !saving && (!asksCurrent || current !== "") && (!asksNext || (next !== "" && next === again));

  const save = async (): Promise<void> => {
    if (!ready) return;
    setSaving(true);
    const outcome = await invoke({
      type: "library:setPassword",
      next: asksNext ? next : null,
      ...(asksCurrent ? { current } : {}),
    });
    setSaving(false);
    if (!outcome.ok) {
      if (outcome.problem.code === "password_wrong") setCurrent("");
      return setProblem(outcome.problem);
    }
    onChanged(outcome.value);
  };

  const field = (
    id: string,
    label: string,
    value: string,
    set: (value: string) => void,
    focus: boolean,
  ): React.JSX.Element => (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
        autoFocus={focus}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={saving}
        onChange={(event) => {
          setProblem(undefined);
          set(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      />
    </label>
  );

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title className="dialog-title">{TITLES[change]}</Dialog.Title>
          <Dialog.Description className="dialog-body">
            {change === "remove"
              ? "Roost will open this library without asking, and so will any older Roost."
              : "Roost will ask for it before it opens this library. It does not encrypt anything: whoever can read the folder can read the library. A Roost older than this one cannot open the library while it has a password."}
          </Dialog.Description>

          {asksCurrent && field("password-current", "Current password", current, setCurrent, true)}
          {asksNext && field("password-next", "New password", next, setNext, !asksCurrent)}
          {asksNext && field("password-again", "Type it again", again, setAgain, false)}

          {mismatch && (
            <p className="dialog-problem" role="alert">
              The two do not match.
            </p>
          )}
          {problem !== undefined && (
            <p className="dialog-problem" role="alert">
              {problem.code === "password_wrong" ? "That is not the password." : problem.message}
            </p>
          )}

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button" disabled={saving}>
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              data-variant="primary"
              disabled={!ready}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : change === "remove" ? "Remove" : "Save"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
