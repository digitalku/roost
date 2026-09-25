import type { WireAssetDetail } from "@roost/contract";
import { invoke } from "../bridge.js";
import { badgeOf, codecName } from "../deriveReason.js";
import { FileProblem } from "../FileProblem.js";
import { KindGlyph } from "../Placeholder.js";
import { duration } from "../timecode.js";

/**
 * What the pane shows where it cannot show the asset (`UI_SPEC.md` §7.3).
 *
 * Reported on 2026-09-24 against a library of HEIC photographs and HEVC clips
 * on a machine with neither decoder: the pane opened **empty** for both. The
 * photograph asked for a rendition, then a thumbnail, and hid itself when
 * neither came; the clip played its sound under a black rectangle, because
 * Chromium drops a video track it cannot decode without raising an error. An
 * empty pane reads as a bug in Roost, and neither was one.
 *
 * So it says, in order: what the file is, why it is not on screen, what is
 * known about it anyway, and what can be done. Where the file's derive is
 * stalled, what can be done is the same card the inspector draws, full size
 * (ADR-0050): its steps, the command where one would help, and the three
 * buttons. Otherwise it is **Open externally** alone.
 */
export function Unshowable({
  detail,
  line,
  hint,
  said,
  cardHeading = true,
}: {
  readonly detail: WireAssetDetail;
  /** Why it is not on screen. One sentence. */
  readonly line: string;
  /** What that means for the person looking, where there is more to say. */
  readonly hint?: string | undefined;
  /** Somebody else's words — the element's, a backend's — shown as they came. */
  readonly said?: string | undefined;
  /**
   * Whether the card repeats its own line: off where `line` already is the
   * card's, as for a photograph with no picture, and on where `line` is about
   * something else, as for a video this window cannot play.
   */
  readonly cardHeading?: boolean;
}): React.JSX.Element {
  const facts = factsOf(detail);
  const stalled = detail.undrawn !== null && badgeOf(detail.undrawn) !== undefined;
  return (
    <div className="preview-unshowable">
      <div className="preview-unshowable-art">
        <KindGlyph kind={detail.kind} />
        <span className="cell-kind">{detail.ext === "" ? "file" : detail.ext}</span>
      </div>
      <p className="preview-unshowable-line">{line}</p>
      {hint !== undefined && <p className="preview-unshowable-hint">{hint}</p>}
      {facts !== "" && <p className="preview-unshowable-facts">{facts}</p>}
      {said !== undefined && said !== "" && <p className="preview-media-said">{said}</p>}
      {stalled ? (
        <FileProblem detail={detail} heading={cardHeading} />
      ) : (
        <div className="preview-unshowable-actions">
          <button
            type="button"
            data-variant="primary"
            onClick={() => void invoke({ type: "asset:openExternally", id: detail.id })}
          >
            Open externally
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * What is known about the file without drawing it: its size in pixels, its
 * length, and what it is encoded with. Derived facts (RL-22), so any of them
 * may be missing, and a missing one is left out rather than written as `?`.
 */
function factsOf(detail: WireAssetDetail): string {
  const parts: string[] = [];
  if (detail.width !== null && detail.height !== null) {
    parts.push(`${detail.width} × ${detail.height}`);
  }
  if (detail.durationMs !== null) parts.push(duration(detail.durationMs));
  const codecs = [detail.props["video.codec"], detail.props["audio.codec"]].filter(
    (codec): codec is string => codec !== undefined,
  );
  if (codecs.length > 0) parts.push(codecs.map(codecName).join(" / "));
  return parts.join(" · ");
}
