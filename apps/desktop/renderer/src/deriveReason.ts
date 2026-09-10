/**
 * What a backend's complaint means, for somebody who has to fix it
 * (`UI_SPEC.md` §3.13).
 *
 * The engine stores what the backend said and hands it over unchanged, minus
 * the paths that differ from file to file. That string is the truth and it is
 * still shown — but *"Input buffer contains unsupported image format"* tells a
 * person nothing about what to do next, and the list exists to be acted on.
 *
 * **The translation lives here rather than in the engine** for two reasons: it
 * is a sentence in the interface's voice, and it changes when a backend changes
 * its wording, which must not mean a migration. Nothing is stored from this
 * file; a message this table does not recognise falls through to a plain line
 * with the original underneath it.
 */

/** A failure said in the interface's own words. */
export interface Explanation {
  /** What went wrong. One line, no jargon. */
  readonly line: string;
  /** What to do about it, where there is anything to do. */
  readonly hint?: string;
}

/**
 * The table, first match wins, so the order is part of the meaning.
 *
 * The damaged-file and missing-file patterns come **before** the ffmpeg one:
 * ffmpeg reports both of those in its own voice, and "ffmpeg could not read
 * this" is the least useful of the three answers.
 */
const PATTERNS: readonly (Explanation & { readonly match: RegExp })[] = [
  {
    match: /unsupported image format|unsupported picture|unknown image format|bad extension/,
    line: "Not the kind of file its name says",
    hint: "A file renamed to .jpg is still whatever it was. Open one externally to see what it really is.",
  },
  {
    match: /premature end|truncated|corrupt|unexpected end|invalid data found|not enough pixels/,
    line: "The file is damaged or incomplete",
    hint: "The bytes stop before the picture does — usually an interrupted copy or download. Only a fresh copy fixes it.",
  },
  {
    match: /eacces|eperm|permission denied|not permitted/,
    line: "Roost is not allowed to read the file",
    hint: "Check who owns the file and what it lets others read, then try again.",
  },
  {
    match: /enoent|no such file|file is missing|unable to open for reading|open failed/,
    line: "Roost could not open the file",
    hint: "For a referenced asset this means the original has moved. Reconnect the drive it is on, or import the file again.",
  },
  {
    match: /timed out after/,
    line: "The file took too long to draw",
    hint: "A very long video or a file on a slow drive. Copying it onto a local disk and trying again usually settles it.",
  },
  {
    match: /pixel limit|image exceeds|too large|dimensions? exceed/,
    line: "The image is larger than this build will draw",
    hint: "The asset and its bytes are safe; only the preview is missing.",
  },
  {
    match: /enomem|out of memory|allocation failed|heap/,
    line: "The machine ran out of memory drawing this",
    hint: "Close what else is running and try again — this one is about the machine, not the file.",
  },
  {
    match: /short read/,
    line: "The file ends sooner than its own header promises",
    hint: "The header describes more bytes than the file has. It was cut short somewhere.",
  },
  {
    match: /font collection contains no faces|no faces/,
    line: "The font has no face to draw",
  },
  {
    match: /^page \d+ of/,
    line: "The document's first page would not render",
    hint: "The file may be encrypted, or built in a way pdfium does not open.",
  },
  {
    match: /produced no frame/,
    line: "ffmpeg found no frame to use",
    hint: "An audio-only file with a video extension does this, and so does a video whose first seconds are missing.",
  },
  {
    match: /ffmpeg|ffprobe/,
    line: "ffmpeg could not read this file",
    hint: "Playing it in another player will say whether the file or the installed ffmpeg is the problem.",
  },
];

/** The line for anything the table does not recognise. */
const UNRECOGNISED: Explanation = {
  line: "Roost could not draw this file",
  hint: "The message underneath is the backend's own. Nothing about the asset itself is lost — only its preview.",
};

/**
 * Turns a stored failure message into a sentence.
 *
 * Matched case-insensitively against the whole message, because the same fault
 * reaches here prefixed by whichever tool reported it.
 */
export function explainFailure(reason: string): Explanation {
  const text = reason.toLowerCase();
  for (const pattern of PATTERNS) {
    if (pattern.match.test(text)) {
      const { match: _match, ...explanation } = pattern;
      return explanation;
    }
  }
  return UNRECOGNISED;
}
