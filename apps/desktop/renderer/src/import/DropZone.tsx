import { useCallback, useEffect, useState } from "react";
import { pathForFile } from "../bridge.js";
import { isOwnDrag } from "../dnd.js";

/**
 * The whole window is the drop target (`UI_SPEC.md` §3), and it says so only
 * while something is being dragged over it.
 *
 * Counting matters here and is easy to get wrong: `dragleave` fires every time
 * the pointer crosses into a child element, so a naive boolean flickers the
 * overlay off and on as the pointer moves across the grid. A depth counter
 * survives that, because every `dragenter` has exactly one matching
 * `dragleave`.
 */

export interface DropZoneProps {
  readonly onDrop: (paths: readonly string[]) => void;
  /**
   * A video or audio preview is open, so a dropped subtitle will attach to it
   * (ADR-0025) and everything else will import.
   *
   * The overlay says both, because it cannot say one: Chromium reports no
   * filename while a drag is in flight, so what a drop holds is not known until
   * it lands. What *is* known is what is on screen, and that is what the
   * sentence describes.
   */
  readonly captioning?: boolean;
}

export function DropZone({ onDrop, captioning }: DropZoneProps): React.JSX.Element | null {
  const [depth, setDepth] = useState(0);

  const stop = useCallback((event: DragEvent) => {
    // Without both, Chromium navigates the window to the dropped file — which
    // in a packaged app means leaving the application (`security.ts` denies the
    // navigation, so the visible result is simply nothing happening).
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    // **Not the window's own drag.** The grid drags out as files (ADR-0034
    // §4), so a selection dragged and let go over the grid would otherwise be
    // offered for import — as copies of itself. It is still stopped, since a
    // file dropped where nothing takes it is one Chromium navigates to.
    const isFiles = (event: DragEvent): boolean => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return false;
      if (!isOwnDrag(event.dataTransfer)) return true;
      stop(event);
      return false;
    };

    const enter = (event: DragEvent): void => {
      if (!isFiles(event)) return;
      stop(event);
      setDepth((held) => held + 1);
    };
    const over = (event: DragEvent): void => {
      if (isFiles(event)) stop(event);
    };
    const leave = (event: DragEvent): void => {
      if (!isFiles(event)) return;
      stop(event);
      setDepth((held) => Math.max(0, held - 1));
    };
    const drop = (event: DragEvent): void => {
      stop(event);
      if (isOwnDrag(event.dataTransfer)) return;
      setDepth(0);
      const files = Array.from(event.dataTransfer?.files ?? []);
      // An empty path means the drop carried something that is not a file on
      // disk — a URL, text from another application — which is not an import.
      const paths = files.map(pathForFile).filter((path) => path !== "");
      if (paths.length > 0) onDrop(paths);
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [onDrop, stop]);

  if (depth === 0) return null;

  return (
    <div className="dropzone" aria-hidden="true">
      <p>
        {captioning === true ? "Drop to import — a subtitle joins this video" : "Drop to import"}
      </p>
    </div>
  );
}
