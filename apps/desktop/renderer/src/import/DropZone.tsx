import { useCallback, useEffect, useState } from "react";
import { pathForFile } from "../bridge.js";

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
}

export function DropZone({ onDrop }: DropZoneProps): React.JSX.Element | null {
  const [depth, setDepth] = useState(0);

  const stop = useCallback((event: DragEvent) => {
    // Without both, Chromium navigates the window to the dropped file — which
    // in a packaged app means leaving the application (`security.ts` denies the
    // navigation, so the visible result is simply nothing happening).
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    const isFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

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
      <p>Drop to import</p>
    </div>
  );
}
