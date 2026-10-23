import type { WireProblem } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useState } from "react";

/**
 * A name asked for once: a new tag, a new group, a rename of either (ADR-0061).
 *
 * The folder dialog's shape (`FolderDialog`), without its knowledge of folders:
 * the caller says what the name is for and does the saving, and a refusal it
 * hands back is shown under the field, with the name still in it to correct.
 */
export interface NameDialogProps {
  readonly title: string;
  /** One sentence about what the name does, under the title. */
  readonly description: string;
  readonly initial?: string;
  readonly placeholder: string;
  /**
   * The button's verb for the name as typed. A rename onto a tag that exists
   * says **Merge**, because that is what it will do.
   */
  readonly confirmLabel: (name: string) => string;
  /** A second sentence for the name as typed, or nothing. */
  readonly hint?: (name: string) => string | undefined;
  /** Saves, and answers with the refusal to show, or nothing when it is done. */
  readonly onSave: (name: string) => Promise<WireProblem | undefined>;
  readonly onClose: () => void;
}

export function NameDialog({
  title,
  description,
  initial = "",
  placeholder,
  confirmLabel,
  hint,
  onSave,
  onClose,
}: NameDialogProps): React.JSX.Element {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<WireProblem | undefined>();

  // Unchanged is not ready, except in case: a rename from `wood` to `Wood` is a
  // rename somebody asked for.
  const ready = name.trim() !== "" && name.trim() !== initial;
  const said = hint?.(name.trim());

  const save = async (): Promise<void> => {
    setSaving(true);
    const refused = await onSave(name.trim());
    setSaving(false);
    if (refused !== undefined) setProblem(refused);
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
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="dialog-body">{description}</Dialog.Description>

          <label className="field" htmlFor="name-dialog-field">
            <span>Name</span>
            <input
              id="name-dialog-field"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
              autoFocus
              type="text"
              value={name}
              placeholder={placeholder}
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

          {said !== undefined && <p className="dialog-body">{said}</p>}
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
              {confirmLabel(name.trim())}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
