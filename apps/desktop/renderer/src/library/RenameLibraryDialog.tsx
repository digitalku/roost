import { LIBRARY_SUFFIX, type LibrarySummary, type WireProblem } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { invoke } from "../bridge.js";

/**
 * Renaming the open library, which is renaming its folder (ADR-0056 §3.2).
 *
 * The folder is the name, so the dialog says which folder the name becomes
 * while it is typed: a person who has renamed one in a file manager should
 * see that this is the same thing.
 *
 * **The engine refuses a name, not this**, as `FolderDialog` does for a
 * folder: a separator, a leading dot, a neighbour of that name. The dialog
 * stays open on a refusal and draws the engine's own message.
 */
export function RenameLibraryDialog({
  current,
  onClose,
  onRenamed,
}: {
  readonly current: string;
  readonly onClose: () => void;
  readonly onRenamed: (summary: LibrarySummary) => void;
}): React.JSX.Element {
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<WireProblem | undefined>();

  const ready = name.trim() !== "" && name.trim() !== current;

  const save = async (): Promise<void> => {
    setSaving(true);
    const renamed = await invoke({ type: "library:rename", name });
    setSaving(false);
    if (!renamed.ok) return setProblem(renamed.problem);
    onRenamed(renamed.value);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title className="dialog-title">Rename library</Dialog.Title>
          <Dialog.Description className="dialog-body">
            The folder becomes <code>{`${name.trim() || current}${LIBRARY_SUFFIX}`}</code>, in the
            same place. Renaming the folder in a file manager while Roost has it closed does the
            same.
          </Dialog.Description>

          <label className="field" htmlFor="library-rename">
            <span>Name</span>
            <input
              id="library-rename"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
              autoFocus
              onFocus={(event) => event.target.select()}
              type="text"
              value={name}
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
              <button type="button" disabled={saving}>
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              data-variant="primary"
              disabled={saving || !ready}
              onClick={() => void save()}
            >
              {saving ? "Renaming…" : "Rename"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
