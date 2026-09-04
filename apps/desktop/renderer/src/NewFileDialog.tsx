import type { WireProblem } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { invoke } from "./bridge.js";

/**
 * Making a file from the grid's empty space (`UI_SPEC.md` §3.4, ADR-0026 §4).
 *
 * **The name is typed, never defaulted.** A file called `untitled` is a file
 * somebody has to rename, and this dialog is already asking a question — so it
 * asks the one that matters first.
 *
 * **It asks for nothing else.** The user's decision on 2026-09-05, after using
 * the version that also asked for contents: a name and a button. What that
 * costs is real and is said where it happens rather than guarded against here —
 * an empty file has one BLAKE3 hash and `assets.hash` is the primary key, so
 * the library holds **one** empty file however many are made, and the second
 * answers with the first. Nor can an external editor fill one in afterwards:
 * originals are immutable and addressed by their content, so editing outside
 * writes bytes that belong to a *different* asset.
 *
 * Words from the clipboard arrive as `initialText` and become the contents
 * without a field, because pasting has already said what they are (ADR-0026
 * §5).
 *
 * A `Dialog` rather than an `AlertDialog`: this is a question with an answer to
 * type, not a confirmation, so it may be dismissed by clicking away and it
 * starts with focus in the field.
 */
export function NewFileDialog({
  initialText,
  onClose,
  onCreated,
  onProblem,
}: {
  /**
   * Pre-filled when the contents came from the clipboard (ADR-0026 §5).
   *
   * Read once, at mount: the caller renders this only while it is open, so
   * there is no second value to keep in step with the first.
   */
  readonly initialText: string;
  readonly onClose: () => void;
  /** `created` is false when the library already held those bytes. */
  readonly onCreated: (hash: string, created: boolean, name: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async (): Promise<void> => {
    setSaving(true);
    const outcome = await invoke({ type: "asset:create", name, text: initialText });
    setSaving(false);
    if (!outcome.ok) return onProblem(outcome.problem);
    onCreated(outcome.value.hash, outcome.value.created, name);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog dialog-wide">
          <Dialog.Title className="dialog-title">New file</Dialog.Title>
          <Dialog.Description className="dialog-body">
            {initialText === ""
              ? "The name carries the extension."
              : `The name carries the extension. It will hold the ${initialText.length} characters you pasted.`}
          </Dialog.Description>

          <label className="field" htmlFor="new-file-name">
            <span>Name</span>
            <input
              id="new-file-name"
              type="text"
              value={name}
              placeholder="notes.txt"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // The only field, so Enter is the button: a form with one
                // answer should not need the pointer to submit it.
                if (event.key === "Enter" && name.trim() !== "" && !saving) {
                  event.preventDefault();
                  void create();
                }
              }}
            />
          </label>

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button">Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              data-variant="primary"
              disabled={saving || name.trim() === ""}
              onClick={() => void create()}
            >
              {saving ? "Creating…" : "Create"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
