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
 * **It asks for contents as well, because it has to.** A file with no bytes has
 * no identity here: every empty file has one BLAKE3 hash and `assets.hash` is
 * the primary key, so an empty `notes.txt` and an empty `notes.md` cannot both
 * exist and a second empty file would be the same asset as the first. Nor could
 * an external editor fill one in afterwards: originals are immutable and
 * addressed by their content, so editing outside would write bytes that belong
 * to a *different* asset and leave this one empty for ever.
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
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);

  const create = async (): Promise<void> => {
    setSaving(true);
    const outcome = await invoke({ type: "asset:create", name, text });
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
            The name carries the extension, and the file needs something in it — an empty file has
            nothing to identify it.
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
                // Enter moves on rather than submitting: the file still has no
                // contents at this point, and a submit that cannot succeed is
                // a key that does nothing.
                if (event.key === "Enter") {
                  event.preventDefault();
                  document.getElementById("new-file-text")?.focus();
                }
              }}
            />
          </label>

          <label className="field" htmlFor="new-file-text">
            <span>Contents</span>
            <textarea
              id="new-file-text"
              className="field-text"
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </label>

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button">Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              data-variant="primary"
              disabled={saving || name.trim() === "" || text === ""}
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
