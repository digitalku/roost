import { open } from "node:fs/promises";
import { IoError, type Kind } from "@roost/core";
import { isRenderable, readDimensions } from "./decoder.js";
import { type Format, kindOf, SNIFF_BYTES, sniff } from "./format.js";

/** What probing learned about a file. */
export interface Probed {
  readonly format: Format;
  readonly kind: Kind;
  /**
   * Present for formats this build can decode. A grid needs them to reserve a
   * cell's shape before the thumbnail arrives, which is the difference between
   * laying out once and reflowing on every load.
   */
  readonly width?: number;
  readonly height?: number;
}

/**
 * Reads a file's header and reports what it is.
 *
 * The header only — never the pixel data — so this stays cheap enough to run on
 * every file during import. Dimensions come from the header too.
 */
export async function probe(path: string): Promise<Probed> {
  const format = await sniffFile(path);
  const base = { format, kind: kindOf(format) };

  if (!isRenderable(format)) return base;

  const dimensions = await readDimensions(path);
  return dimensions === undefined ? base : { ...base, ...dimensions };
}

/**
 * Identifies a file from its first {@link SNIFF_BYTES} bytes.
 *
 * A short file is not an error: a three-byte file is a perfectly valid asset
 * that happens to match no signature. One `pread` of 64 bytes, which is why
 * both probing and thumbnailing can afford to do it independently rather than
 * threading a format between them.
 */
export async function sniffFile(path: string): Promise<Format> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (cause) {
    throw new IoError("open", path, cause);
  }

  try {
    const buffer = Buffer.allocUnsafe(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return sniff(buffer.subarray(0, bytesRead));
  } catch (cause) {
    throw new IoError("read", path, cause);
  } finally {
    await handle.close();
  }
}
