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

/**
 * Which backend a parked reason is waiting for.
 *
 * The reason names the **tool** and the capability names the **backend**, and
 * they are not the same word: `missing:ffmpeg` parks on `media` and
 * `missing:libheif` on `heif` (ADR-0040). Pairing them by position — the first
 * parked reason against the first unavailable capability — worked while only
 * one backend could be missing, and started naming the wrong tool the moment a
 * second one could.
 */
const CAPABILITY_OF_REASON: Readonly<Record<string, string>> = {
  "missing:ffmpeg": "media",
  "missing:libheif": "heif",
};

/**
 * The backend a parked reason is waiting on, or `undefined` for work that is
 * waiting on nothing anybody can install.
 *
 * `missing:decoder:<codec>` waits on `media` too — on a fuller ffmpeg rather
 * than on any ffmpeg at all (ADR-0017, amended 2026-09-24).
 */
export function capabilityOfReason(reason: string): string | undefined {
  return CAPABILITY_OF_REASON[reason] ?? (reason.startsWith(DECODER) ? "media" : undefined);
}

const DECODER = "missing:decoder:";

/**
 * The codec a reason says this ffmpeg cannot decode.
 *
 * Two spellings of one fault: the queue's own, for a file it declined to try,
 * and ffmpeg's, for one that reached it anyway — which is what every such file
 * in a library derived before the check says.
 */
export function decoderOf(reason: string): string | undefined {
  if (reason.startsWith(DECODER)) return reason.slice(DECODER.length) || undefined;
  return /no decoder found for:?\s*([\w-]+)/i.exec(reason)?.[1];
}

/**
 * What a codec is called by somebody who has met it on a phone or a disc
 * rather than in `ffmpeg -decoders`.
 */
const CODEC_NAMES: Readonly<Record<string, string>> = {
  hevc: "HEVC (H.265)",
  h264: "H.264",
  av1: "AV1",
  vp9: "VP9",
  aac: "AAC",
  ac3: "AC-3 (Dolby Digital)",
  eac3: "E-AC-3 (Dolby Digital Plus)",
  vc1: "VC-1",
  wmv3: "Windows Media Video 9",
  prores: "ProRes",
};

/** A codec as a person names it, `HEVC (H.265)` for `hevc`. */
export function codecName(codec: string): string {
  return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

/** A failure said in the interface's own words. */
export interface Explanation {
  /** What went wrong. One line, no jargon. */
  readonly line: string;
  /** Why, where there is more to say than the line. */
  readonly hint?: string;
  /**
   * What somebody can do about it, for this file, in the order worth trying
   * (ADR-0050). Each is a sentence that names the button it needs, where one of
   * the card's buttons is the way to do it.
   */
  readonly steps?: readonly string[];
}

/**
 * The table, first match wins, so the order is part of the meaning.
 *
 * The queue's **own** reasons come first and are anchored: `missing:libheif`
 * and `unsupported:unknown` are strings Roost writes rather than something a
 * backend said, so they match exactly and never by accident. After them come
 * the backends' own words, where the damaged-file and missing-file patterns sit
 * **before** the ffmpeg one — ffmpeg reports both of those in its own voice,
 * and "ffmpeg could not read this" is the least useful of the three answers.
 */
const PATTERNS: readonly (Explanation & { readonly match: RegExp })[] = [
  {
    // Parked on a decoder that is not here (ADR-0040). The command to install
    // it comes from the engine, which is the only side that knows what this
    // machine runs, and the dialog draws it under the sentence.
    match: /^missing:libheif$/,
    line: "HEIC photographs need libheif",
    hint: "Apple's photographs are HEVC, which is patented — so the decoder is the system's rather than something Roost can ship.",
    steps: [
      "Install the decoder with the command below.",
      "Then press Try again: every HEIC waiting for it is drawn, not only this one.",
    ],
  },
  {
    match: /^missing:ffmpeg$/,
    line: "Videos and audio need ffmpeg",
    hint: "Roost uses the ffmpeg already on the machine and never bundles one (ADR-0017).",
    steps: [
      "Install ffmpeg with the command below.",
      "Then press Try again: every file waiting for it is drawn, not only this one.",
    ],
  },
  {
    // Parked by the queue: the id has no file under `files/` (RL-25).
    match: /^missing:file$/,
    line: "The file is not in the library",
    hint: "Something moved or deleted it inside the library's files folder. Its tags, rating and notes are all still here.",
    steps: ["Restore it from a backup to the same place, then press Try again."],
  },
  {
    // Two files carry this id (RL-12), and the queue does not choose.
    match: /^ambiguous:file$/,
    line: "Two files in the library claim this asset",
    hint: "Another program left a second file with the same id, and Roost will not guess which one is meant.",
    steps: [
      "Run roost doctor to see both, and remove the one that is not wanted.",
      "Then press Try again.",
    ],
  },
  {
    match: /^missing:original$/,
    line: "The original file is not where it was",
    hint: "A referenced asset points at a file outside the library. Reconnect the drive it is on, and this releases itself.",
    steps: ["Reconnect the drive the file is on, then press Try again."],
  },
  {
    match: /^unsupported:text$/,
    line: "Nothing here draws a text file yet",
    hint: "It imported, it is searchable, and it opens in whatever owns it — only the picture is missing.",
    steps: ["Open it externally to read it."],
  },
  {
    match: /^unsupported:unknown$/,
    line: "Roost does not recognise this kind of file",
    hint: "Nothing in the first 64 bytes matched a format it knows. The file is kept exactly as it is and opens externally.",
  },
  {
    match: /^unsupported:/,
    line: "Nothing in this build draws this format",
    hint: "Not a fault: the file is in the library, and only a preview is missing.",
  },
  {
    match: /unsupported image format|unsupported picture|unknown image format|bad extension/,
    line: "Not the kind of file its name says",
    hint: "A file renamed to .jpg is still whatever it was. Open one externally to see what it really is.",
    steps: [
      "Open it externally: the application that opens it will say what it really is.",
      "If it is a picture after all, save it again from that application and press Try again.",
    ],
  },
  {
    match: /premature end|truncated|corrupt|unexpected end|invalid data found|not enough pixels/,
    line: "The file is damaged or incomplete",
    hint: "The bytes stop before the picture does — usually an interrupted copy or download. Only a fresh copy fixes it.",
    steps: [
      "Get a fresh copy from wherever this one came from.",
      "Show in folder, and put the fresh copy in its place under the same name: Roost notices and draws it.",
      "Open it externally to check whether any application can still read this copy.",
    ],
  },
  {
    match: /eacces|eperm|permission denied|not permitted/,
    line: "Roost is not allowed to read the file",
    hint: "Check who owns the file and what it lets others read, then try again.",
    steps: [
      "Show in folder, and check who owns the file and what it allows.",
      "Then press Try again.",
    ],
  },
  {
    match: /enoent|no such file|file is missing|unable to open for reading|open failed/,
    line: "Roost could not open the file",
    hint: "For a referenced asset this means the original has moved. Reconnect the drive it is on, or import the file again.",
    steps: [
      "Show in folder, to see whether the file is still there.",
      "If it is, press Try again; if not, restore it from a backup to the same place.",
    ],
  },
  {
    match: /timed out after/,
    line: "The file took too long to draw",
    hint: "A very long video or a file on a slow drive. Copying it onto a local disk and trying again usually settles it.",
    steps: ["Press Try again when the machine is less busy."],
  },
  {
    match: /pixel limit|image exceeds|too large|dimensions? exceed/,
    line: "The image is larger than this build will draw",
    hint: "The asset and its bytes are safe; only the preview is missing.",
    steps: ["Open it externally to see it at full size."],
  },
  {
    match: /enomem|out of memory|allocation failed|heap/,
    line: "The machine ran out of memory drawing this",
    hint: "Close what else is running and try again — this one is about the machine, not the file.",
    steps: ["Close what else is running, then press Try again."],
  },
  {
    match: /short read/,
    line: "The file ends sooner than its own header promises",
    hint: "The header describes more bytes than the file has. It was cut short somewhere.",
    steps: [
      "Get a fresh copy from wherever this one came from.",
      "Show in folder, and put the fresh copy in its place under the same name: Roost notices and draws it.",
    ],
  },
  {
    match: /font collection contains no faces|no faces/,
    line: "The font has no face to draw",
    steps: ["Open it externally to check whether the font installs at all."],
  },
  {
    match: /^page \d+ of/,
    line: "The document's first page would not render",
    hint: "The file may be encrypted, or built in a way pdfium does not open.",
    steps: ["Open it externally: if it asks for a password, that is why."],
  },
  {
    match: /produced no frame/,
    line: "ffmpeg found no frame to use",
    hint: "An audio-only file with a video extension does this, and so does a video whose first seconds are missing.",
    steps: ["Open it externally: if it plays only sound, there is no picture to draw."],
  },
  {
    match: /ffmpeg|ffprobe/,
    line: "ffmpeg could not read this file",
    hint: "Playing it in another player will say whether the file or the installed ffmpeg is the problem.",
    steps: [
      "Open it externally. If it plays there, the installed ffmpeg is what cannot read it.",
      "If it does not play anywhere, the file itself is damaged: get a fresh copy.",
    ],
  },
];

/** The line for anything the table does not recognise. */
const UNRECOGNISED: Explanation = {
  line: "Roost could not draw this file",
  hint: "The message underneath is the backend's own. Nothing about the asset itself is lost — only its preview.",
  steps: [
    "Press Try again once: some failures are the machine's and not the file's.",
    "If it fails the same way, open it externally to check the file itself.",
  ],
};

/**
 * Turns a stored failure message into a sentence.
 *
 * Matched case-insensitively against the whole message, because the same fault
 * reaches here prefixed by whichever tool reported it.
 */
export function explainFailure(reason: string): Explanation {
  // Ahead of the table, because the line names the codec and a pattern's line
  // is a constant.
  const codec = decoderOf(reason);
  if (codec !== undefined) {
    return {
      line: `The installed ffmpeg cannot decode ${codecName(codec)}`,
      hint: "The file is fine. Some distributions leave patented codecs out of the ffmpeg they ship, and Roost uses the system's — so a fuller ffmpeg is what draws these.",
      steps: [
        "Replace the installed ffmpeg with the command below.",
        "Then press Try again: every file waiting for it is drawn, not only this one.",
      ],
    };
  }

  const text = reason.toLowerCase();
  for (const pattern of PATTERNS) {
    if (pattern.match.test(text)) {
      const { match: _match, ...explanation } = pattern;
      return explanation;
    }
  }
  return UNRECOGNISED;
}

/**
 * Whether a reason is the queue parking work rather than a backend failing it.
 *
 * The queue's own reasons are the only ones with a `word:` prefix; everything
 * else is what a backend said. The two open different halves of the list
 * (`UI_SPEC.md` §3.13), so a control that opens it has to know which.
 */
export function isParked(reason: string): boolean {
  return /^(missing|unsupported|ambiguous):/.test(reason);
}

/**
 * The few words a cell has room for, or `undefined` where a cell should say
 * nothing (`UI_SPEC.md` §6.1).
 *
 * **A format nothing draws gets no badge.** A `.zip` with no picture is what a
 * library that holds anything looks like (`CONCEPT.md` §5), not a fault, and a
 * warning on every archive would teach people to ignore the one on a
 * photograph. The badge is for a picture that *could* be drawn — by installing
 * something, or by fixing the file — and the whole sentence is its tooltip.
 */
export function badgeOf(reason: string): string | undefined {
  if (reason.startsWith("unsupported:")) return undefined;
  const codec = decoderOf(reason);
  if (codec !== undefined) return `No ${shortCodec(codec)} decoder`;
  switch (reason) {
    case "missing:libheif":
      return "Needs libheif";
    case "missing:ffmpeg":
      return "Needs ffmpeg";
    case "missing:file":
      return "File is missing";
    case "ambiguous:file":
      return "Two files, one id";
    default:
      return "Could not be drawn";
  }
}

/** `HEVC` rather than `HEVC (H.265)`: the long name is the tooltip's. */
function shortCodec(codec: string): string {
  return codecName(codec).replace(/\s*\(.*\)$/, "");
}
