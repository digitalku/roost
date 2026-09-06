import type { WireEagleSurvey, WireProblem } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { invoke } from "../bridge.js";
import { bytes } from "../format.js";

/**
 * What importing an Eagle library would do, before it does it
 * (`UI_SPEC.md` §3.8, ADR-0032 §6).
 *
 * **It is not a filter.** Nothing is selected here — the import brings
 * everything, which is the user's decision of 2026-09-06 — so this dialog
 * exists to answer *what am I about to do*, including the parts that cannot be
 * carried across. That makes it the one place those can be said at a moment
 * when they are still actionable: afterwards, a missing colour palette is
 * indistinguishable from a colour palette that was never there.
 *
 * A `Dialog` and not an `AlertDialog`. An import is not destructive — Eagle's
 * library is only ever read, and what arrives here can be trashed like anything
 * else — so it may be dismissed by clicking away, and its confirm is a plain
 * button rather than a danger one.
 *
 * The survey is fetched when the dialog opens rather than passed in: it costs a
 * read per item and the caller has only a path.
 */
export function EagleDialog({
  path,
  onCancel,
  onImport,
}: {
  /** The directory the chooser returned. */
  readonly path: string;
  readonly onCancel: () => void;
  readonly onImport: () => void;
}): React.JSX.Element {
  const [survey, setSurvey] = useState<WireEagleSurvey | undefined>();
  const [problem, setProblem] = useState<WireProblem | undefined>();

  useEffect(() => {
    let live = true;
    void (async () => {
      const answer = await invoke({ type: "eagle:survey", path });
      // The dialog may already be gone: a survey of a large library takes long
      // enough to cancel through.
      if (!live) return;
      if (answer.ok) setSurvey(answer.value);
      else setProblem(answer.problem);
    })();
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog dialog-wide" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">Import from Eagle</Dialog.Title>

          {problem !== undefined ? (
            <p className="dialog-body">
              {/*
                The one failure this dialog is really for: a directory that is
                not an Eagle library. The engine says which file was missing,
                and repeating that is more use than "could not read it".
              */}
              {problem.message}
            </p>
          ) : survey === undefined ? (
            <p className="dialog-body">Reading the library…</p>
          ) : (
            <EagleSummary survey={survey} />
          )}

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button">Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              // No `button-danger`, and no primary ramp either: the danger
              // colours mean "cannot be undone" (`UI_SPEC.md` §2), and there is
              // no third style here — **New file…** confirms with a plain
              // button too.
              //
              // Nothing to import is a reason to disable it: a survey of zero
              // items is a directory that looks like a library and holds none.
              disabled={survey === undefined || survey.items === 0}
              onClick={onImport}
            >
              Import
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EagleSummary({ survey }: { readonly survey: WireEagleSurvey }): React.JSX.Element {
  // Only what this library actually has. A row reading "0 comments" is a line
  // of text about something the user does not use.
  const holds = [
    line(survey.tags, "tag", "tags"),
    line(survey.folders, "folder", "folders"),
    line(survey.tagGroups, "tag group", "tag groups"),
    line(survey.rated, "rated", "rated"),
    line(survey.notes, "note", "notes"),
    line(survey.sources, "URL", "URLs"),
    line(survey.comments, "comment", "comments"),
    line(survey.subtitles, "subtitle", "subtitles"),
    line(survey.trashed, "in Eagle's trash", "in Eagle's trash"),
  ].filter((part) => part !== undefined);

  return (
    <div className="eagle-summary">
      <p className="dialog-body">
        Eagle {survey.version} · {survey.items.toLocaleString()}{" "}
        {survey.items === 1 ? "item" : "items"} · {bytes(survey.bytes)}
      </p>
      {holds.length > 0 && <p className="eagle-line">{holds.join(" · ")}</p>}

      <p className="eagle-heading">Not carried across</p>
      <ul className="eagle-list">
        <li>Eagle's thumbnails — Roost draws its own</li>
        <li>Colour palettes, smart folders, quick access</li>
        {/*
          The one loss that cannot be recovered later, so it is said at the only
          moment the Eagle library is certainly still there (ADR-0032 §7). The
          file's own date survives, which is the half that makes this bearable.
        */}
        <li>Eagle's “date added” — everything will carry today's date instead</li>
      </ul>

      {survey.renamedFolders.length > 0 && (
        <>
          <p className="eagle-heading">Folders that will be renamed</p>
          <ul className="eagle-list">
            {survey.renamedFolders.slice(0, 5).map((rename) => (
              <li key={rename.from}>
                {rename.from} → {rename.to}
              </li>
            ))}
            {survey.renamedFolders.length > 5 && (
              <li>…and {survey.renamedFolders.length - 5} more</li>
            )}
          </ul>
        </>
      )}

      {(survey.missing > 0 || survey.unreadable > 0) && (
        <p className="eagle-warning">
          {[
            line(survey.missing, "item has no file where Eagle says it is", "items have no file"),
            line(survey.unreadable, "item cannot be read", "items cannot be read"),
          ]
            .filter((part) => part !== undefined)
            .join(" · ")}
          . They will be skipped.
        </p>
      )}
    </div>
  );
}

/** A count and its noun, or nothing at all when the count is zero. */
function line(count: number, one: string, many: string): string | undefined {
  if (count === 0) return undefined;
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
