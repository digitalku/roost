import type { WireProblem } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { invoke } from "../bridge.js";

/**
 * Naming a folder, whether it is being made or renamed (ADR-0033).
 *
 * One dialog for both, because they ask the same question and would otherwise
 * be two places to get the same refusal wrong. What differs is the title, the
 * button, and what the answer is sent to — all three arrive as props.
 *
 * **The engine is what refuses a name, not this.** A name containing `/` is
 * ambiguous — a top-level `Design/Icons` and an `Icons` inside `Design` compile
 * to the same `folder:` query — and `@roost/library` says so with
 * `AmbiguousFolderNameError`. Re-checking it here would be a second copy of a
 * rule that already exists, and the copy is what drifts. The dialog stays open
 * on a refusal and draws the engine's own message, which is the one that will
 * still be right when the rule changes.
 *
 * A `Dialog` rather than an `AlertDialog`: a question with an answer to type is
 * not a confirmation, so it dismisses by clicking away and opens with the caret
 * in the field.
 */

export interface FolderDialogProps {
  /** `create` needs the parent; `rename` needs the folder. */
  readonly what:
    | { readonly kind: "create"; readonly parent: number | null; readonly under: string | null }
    | { readonly kind: "rename"; readonly folder: number; readonly name: string };
  readonly onClose: () => void;
  /** The folder that was made or renamed, for the caller to reveal and say so. */
  readonly onDone: (folder: number, name: string) => void;
}

export function FolderDialog({ what, onClose, onDone }: FolderDialogProps): React.JSX.Element {
  const [name, setName] = useState(what.kind === "rename" ? what.name : "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<WireProblem | undefined>();

  const ready = name.trim() !== "" && !(what.kind === "rename" && name === what.name);

  const save = async (): Promise<void> => {
    setSaving(true);
    // The two calls are written out rather than picked into one variable: their
    // answers are different types, and a union of them would have to be
    // narrowed again on the way out.
    if (what.kind === "create") {
      const made = await invoke({ type: "folder:create", name, parent: what.parent });
      setSaving(false);
      // Kept open on a refusal: the name is still in the field, and the
      // message is about the name.
      if (!made.ok) return setProblem(made.problem);
      return onDone(made.value, name.trim());
    }

    const renamed = await invoke({ type: "folder:rename", folder: what.folder, name });
    setSaving(false);
    if (!renamed.ok) return setProblem(renamed.problem);
    onDone(what.folder, name.trim());
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
        <Dialog.Content className="dialog">
          <Dialog.Title className="dialog-title">
            {what.kind === "create" ? "New folder" : "Rename folder"}
          </Dialog.Title>
          <Dialog.Description className="dialog-body">
            {what.kind === "create"
              ? what.under === null
                ? "A folder is a collection: putting a file in one moves nothing on disk."
                : `Inside ${what.under}.`
              : "The assets in it stay where they are; only the name changes."}
          </Dialog.Description>

          <label className="field" htmlFor="folder-name">
            <span>Name</span>
            <input
              id="folder-name"
              // Radix takes the focus into the first focusable element, which
              // is this — and here the caret belongs at the end, unlike the new
              // file dialog where an extension follows it.
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
              autoFocus
              type="text"
              value={name}
              placeholder="Logos"
              spellCheck={false}
              onChange={(event) => {
                setProblem(undefined);
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready && !saving) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </label>

          {problem !== undefined && (
            <p className="dialog-problem" role="alert">
              {problem.message}
            </p>
          )}

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button">Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              data-variant="primary"
              disabled={saving || !ready}
              onClick={() => void save()}
            >
              {what.kind === "create" ? "Create" : "Rename"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
