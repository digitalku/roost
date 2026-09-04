/**
 * What a text asset's bytes say, and in which encoding they say it.
 *
 * Roost stores the file the user gave it and never rewrites it (invariant 6),
 * so the encoding is a property of the bytes rather than a promise the library
 * made. `roost://` serves a text asset as `text/plain` with **no charset** for
 * exactly this reason (ADR-0026): asserting UTF-8 on the wire would make a
 * Windows-1252 subtitle — which is most of them — render as mojibake that reads
 * like the file's own fault.
 *
 * So the viewer decodes, rather than letting `Response.text()` do it.
 */

/** A BOM, and what it declares. */
const BOMS: readonly (readonly [readonly number[], string])[] = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xff, 0xfe], "utf-16le"],
  [[0xfe, 0xff], "utf-16be"],
];

export interface DecodedText {
  readonly text: string;
  /** The encoding the text was read as. */
  readonly encoding: string;
  /**
   * Whether that encoding was inferred rather than declared.
   *
   * A file with a BOM says what it is. Everything else is a decision made from
   * the bytes, and the viewer says so instead of presenting a guess as a fact.
   */
  readonly guessed: boolean;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * Decodes a text asset, naming the encoding it used.
 *
 * Three steps, in the order that trusts the file most: a BOM if there is one,
 * then UTF-8 if the bytes are valid UTF-8, then Windows-1252 — which cannot
 * fail, decodes every byte to something, and is therefore the last one tried
 * rather than a considered answer.
 *
 * **Whether the window is the whole file changes the answer**, which is why the
 * caller has to say. A large file is read as a range, so the last character can
 * be cut in half; `stream: true` holds that tail back instead of calling the
 * file invalid on nothing but where the read stopped. On a *complete* file the
 * same tolerance would be wrong — a trailing byte that begins a sequence and
 * never finishes it is precisely how a legacy encoding announces itself, and
 * holding it back would read `Café` as `Caf` and call it UTF-8.
 */
export function decodeText(bytes: Uint8Array, truncated = false): DecodedText {
  for (const [bom, encoding] of BOMS) {
    if (startsWith(bytes, bom)) {
      const body = bytes.subarray(bom.length);
      return {
        text: new TextDecoder(encoding).decode(body, { stream: truncated }),
        encoding,
        guessed: false,
      };
    }
  }

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }),
      encoding: "utf-8",
      guessed: true,
    };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      encoding: "windows-1252",
      guessed: true,
    };
  }
}
