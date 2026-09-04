import type { WireProblem } from "@roost/contract";
import { useState } from "react";
import { invoke } from "../bridge.js";

/**
 * A file that does not exist yet (`UI_SPEC.md` §7, ADR-0026 §4).
 *
 * **New File** cannot create a row, because in a content-addressed store a file
 * with no bytes has no identity: every empty file has one BLAKE3 hash and
 * `assets.hash` is the primary key, so an empty `notes.txt` and an empty
 * `notes.md` cannot both exist and "New File" twice would yield one asset. A
 * draft is what carries a name until there are bytes to identify — and the
 * first save is also the first moment the extension means anything.
 *
 * The name is editable here rather than asked for in a dialog: the extension is
 * part of the name, and a prompt that asks for one before there is anything to
 * put in the file asks in the wrong order.
 */
export function DraftEditor({
  initialName,
  initialText,
  onCancel,
  onSaved,
  onProblem,
}: {
  readonly initialName: string;
  readonly initialText: string;
  /** Abandoned. Nothing was written, so there is nothing to undo. */
  readonly onCancel: () => void;
  /** Saved. `created` is false when those bytes were already in the library. */
  readonly onSaved: (hash: string, created: boolean, name: string) => void;
  readonly onProblem: (problem: WireProblem) => void;
}): React.JSX.Element {
  const [name, setName] = useState(initialName);
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    const outcome = await invoke({ type: "asset:create", name, text });
    setSaving(false);
    if (outcome.ok) onSaved(outcome.value.hash, outcome.value.created, name);
    else onProblem(outcome.problem);
  };

  return (
    <div className="preview-text preview-draft">
      <header className="preview-draft-name">
        <label htmlFor="draft-name">Name</label>
        <input
          id="draft-name"
          type="text"
          value={name}
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
        />
      </header>
      <textarea
        className="preview-text-body preview-text-editor"
        aria-label="New file"
        value={text}
        spellCheck={false}
        // A draft opens for typing into, and the name above it already has a
        // sensible default — so the cursor belongs in the body, not in a field
        // somebody would have to tab out of.
        // biome-ignore lint/a11y/noAutofocus: see above
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <footer className="preview-text-note">
        {/* Said before it is refused, rather than after: an empty file is the
            one thing this cannot make (ADR-0026 §4). */}
        <span>
          {text === "" ? "Type something — an empty file cannot be saved" : "Not saved yet"}
        </span>
        <span className="preview-text-actions">
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            data-variant="primary"
            onClick={() => void save()}
            disabled={saving || text === "" || name.trim() === ""}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </footer>
    </div>
  );
}
