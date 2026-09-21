import type { WireProblem } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useRef, useState } from "react";
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
 * an empty file has one BLAKE3 id and `assets.id` is the primary key, so
 * the library holds **one** empty file however many are made, and the second
 * answers with the first. Nor can an external editor fill one in afterwards:
 * originals are immutable and addressed by their content, so editing outside
 * writes bytes that belong to a *different* asset.
 *
 * Words from the clipboard arrive as `initialText` and become the contents
 * without a field, because pasting has already said what they are (ADR-0026
 * §5).
 *
 * **New text document…** is this same dialog with `initialName` set to `.txt`
 * and the caret in front of it. It is not a second kind of file — Roost has no
 * file types, only bytes and a name — it is the one guess the dialog can make
 * on the user's behalf, made where the menu already said what was wanted.
 *
 * A `Dialog` rather than an `AlertDialog`: this is a question with an answer to
 * type, not a confirmation, so it may be dismissed by clicking away and it
 * starts with focus in the field.
 */
export function NewFileDialog({
  initialName,
  initialText,
  onClose,
  onCreated,
  onProblem,
}: {
  /**
   * What the name field starts with, and the caret lands before its extension.
   *
   * Read once, at mount, for the same reason `initialText` is: the dialog is
   * mounted only while it is open.
   */
  readonly initialName: string;
  /**
   * Pre-filled when the contents came from the clipboard (ADR-0026 §5).
   *
   * Read once, at mount: the caller renders this only while it is open, so
   * there is no second value to keep in step with the first.
   */
  readonly initialText: string;
  readonly onClose: () => void;
  /** `created` is false when the library already held those bytes. */
  readonly onCreated: (id: string, name: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
}): React.JSX.Element {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // The prefill is not an answer: `.txt` on its own would make a file called
  // `.txt`. Comparing against what the field opened with covers both cases —
  // with no prefill it is exactly "the name is empty".
  const ready = name.trim() !== "" && name.trim() !== initialName;

  const create = async (): Promise<void> => {
    setSaving(true);
    const outcome = await invoke({ type: "asset:create", name, text: initialText });
    setSaving(false);
    if (!outcome.ok) return onProblem(outcome.problem);
    onCreated(outcome.value.id, name);
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
        <Dialog.Content
          className="dialog dialog-wide"
          onOpenAutoFocus={(event) => {
            // Radix's own autofocus would land the caret at the end, which for
            // `.txt` is the one place a name cannot be typed. Taking the focus
            // by hand is the only way to place it, since there is no
            // `autofocus` attribute that also says where.
            event.preventDefault();
            const input = field.current;
            if (input === null) return;
            input.focus();
            const dot = initialName.lastIndexOf(".");
            const caret = dot === -1 ? initialName.length : dot;
            input.setSelectionRange(caret, caret);
          }}
        >
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
              ref={field}
              type="text"
              value={name}
              placeholder="notes.txt"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // The only field, so Enter is the button: a form with one
                // answer should not need the pointer to submit it.
                if (event.key === "Enter" && ready && !saving) {
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
              disabled={saving || !ready}
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
