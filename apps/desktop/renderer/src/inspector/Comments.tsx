import type { WireAssetDetail, WireComment } from "@roost/contract";
import { useEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { playhead, usePlayer } from "../preview/playhead.js";
import { timecode } from "../timecode.js";

/**
 * Comments on one asset, under the note (`UI_SPEC.md` §3.2, ADR-0023).
 *
 * **Several comments, where the note is one.** A note is the paragraph about an
 * asset and is edited in place; a comment is one remark, keeps its own identity,
 * and may point at a moment inside the medium. The two are not versions of each
 * other and neither replaces the other.
 *
 * **A moment is captured at the first keystroke**, not when the comment is sent.
 * "At this point, …" is what a person means, and a video that goes on playing
 * while they type would otherwise record the moment they stopped writing. The
 * chip is removable, which is how the same field writes a comment about the
 * whole asset while a player is on screen.
 *
 * Timed comments seek the preview through {@link playhead} rather than through a
 * prop: the player is in another subtree, and threading a ref up through `App`
 * would give every component on the way a prop about a feature it has nothing to
 * do with. With no preview open there is nothing to seek, so the timecode is
 * text rather than a button — a control that does nothing is worse than none.
 */

export interface CommentsProps {
  readonly detail: WireAssetDetail;
  /** Re-reads the asset. Every edit reads the record back (`UI_SPEC.md` §3). */
  readonly onSaved: () => Promise<void>;
}

export function Comments({ detail, onSaved }: CommentsProps): React.JSX.Element {
  const [editing, setEditing] = useState<number | undefined>();
  const player = usePlayer();

  return (
    <section className="comments" aria-label="Comments">
      {detail.comments.length > 0 && (
        <ul className="comment-list">
          {detail.comments.map((comment) => (
            <li key={comment.id} className="comment">
              {editing === comment.id ? (
                <Editor comment={comment} onDone={() => setEditing(undefined)} onSaved={onSaved} />
              ) : (
                <Row
                  comment={comment}
                  canSeek={player}
                  onEdit={() => setEditing(comment.id)}
                  onSaved={onSaved}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Composer detail={detail} onSaved={onSaved} />
    </section>
  );
}

/** One comment as it is read: its moment, its text, and what can be done to it. */
function Row({
  comment,
  canSeek,
  onEdit,
  onSaved,
}: {
  readonly comment: WireComment;
  readonly canSeek: boolean;
  readonly onEdit: () => void;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  // Read out of the closure's way: narrowing `comment.atMs` does not survive
  // into a handler that runs later.
  const at = comment.atMs;

  return (
    <>
      {at !== null &&
        (canSeek ? (
          <button
            type="button"
            className="comment-at"
            aria-label={`Play from ${timecode(at)}`}
            onClick={() => playhead.seek(at)}
          >
            {timecode(at)}
          </button>
        ) : (
          <span className="comment-at" data-idle>
            {timecode(at)}
          </span>
        ))}
      <p className="comment-body">{comment.body}</p>
      <div className="comment-actions">
        <button type="button" aria-label="Edit comment" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          aria-label="Remove comment"
          onClick={() => {
            void invoke({ type: "comment:remove", id: comment.id }).then(onSaved);
          }}
        >
          ×
        </button>
      </div>
    </>
  );
}

/**
 * One comment being edited, in place.
 *
 * In place rather than removed and re-added, which is the whole reason
 * `comment:set` exists: re-adding would mint a new id and move the comment to
 * the end of every list ordered by creation, and somebody fixing a typo did not
 * ask for that (ADR-0023).
 *
 * An emptied field cancels rather than deletes. Removing has its own button,
 * and a gesture that destroys something by leaving it blank is one nobody can
 * undo by pressing Escape.
 */
function Editor({
  comment,
  onDone,
  onSaved,
}: {
  readonly comment: WireComment;
  readonly onDone: () => void;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(comment.body);
  const [moment, setMoment] = useState(comment.atMs);
  const field = useRef<HTMLInputElement>(null);

  // Focus is finishing what the click that opened this started, and an editor
  // that needs a second click to type in is one nobody would use twice.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const save = (): void => {
    const body = draft.trim();
    if (body === "" || (body === comment.body && moment === comment.atMs)) {
      onDone();
      return;
    }
    void invoke({ type: "comment:set", id: comment.id, atMs: moment, body }).then(async () => {
      await onSaved();
      onDone();
    });
  };

  return (
    <>
      {moment !== null && <Moment atMs={moment} onClear={() => setMoment(null)} />}
      <input
        ref={field}
        className="comment-input"
        aria-label="Edit comment"
        spellCheck={false}
        value={draft}
        onChange={(changed) => setDraft(changed.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
      />
    </>
  );
}

/** Writes one, at the moment the player is at if there is one. */
function Composer({
  detail,
  onSaved,
}: {
  readonly detail: WireAssetDetail;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [moment, setMoment] = useState<number | null>(null);
  const player = usePlayer();

  const submit = (): void => {
    const body = draft.trim();
    if (body === "") return;
    setDraft("");
    setMoment(null);
    void invoke({ type: "comment:add", asset: detail.id, atMs: moment, body }).then(onSaved);
  };

  return (
    <div className="comment-compose">
      {moment !== null && <Moment atMs={moment} onClear={() => setMoment(null)} />}
      <input
        className="comment-input"
        aria-label="Add a comment"
        placeholder={player ? "Comment at this moment" : "Add a comment"}
        spellCheck={false}
        value={draft}
        onChange={(changed) => {
          // Taken on the first keystroke and then left alone: see the note at
          // the top of this file.
          if (draft === "" && changed.target.value !== "") setMoment(playhead.now());
          setDraft(changed.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") {
            setDraft("");
            setMoment(null);
          }
        }}
      />
    </div>
  );
}

/** The moment a comment will carry, and the way to drop it. */
function Moment({
  atMs,
  onClear,
}: {
  readonly atMs: number;
  readonly onClear: () => void;
}): React.JSX.Element {
  return (
    <span className="comment-moment">
      {timecode(atMs)}
      <button type="button" aria-label="Comment on the whole asset instead" onClick={onClear}>
        ×
      </button>
    </span>
  );
}
