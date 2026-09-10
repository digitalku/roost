import { describe, expect, it } from "vitest";
import { explainFailure } from "./deriveReason.js";

/**
 * The sentences the failure list is read for.
 *
 * The messages here are the real ones, copied from what the backends actually
 * produce — sharp's corrupt-header line is what a truncated download looks like
 * from inside the queue, and it is the one that sent the user asking what "36
 * could not be drawn" meant.
 */
describe("saying what a backend's complaint means", () => {
  it("reads sharp's corrupt header as a damaged file", () => {
    const explained = explainFailure(
      "Input file has corrupt header: VipsJpeg: premature end of JPEG image",
    );

    expect(explained.line).toBe("The file is damaged or incomplete");
    expect(explained.hint).toContain("fresh copy");
  });

  it("reads an unsupported format as a file that is not what it is called", () => {
    expect(explainFailure("Input buffer contains unsupported image format").line).toBe(
      "Not the kind of file its name says",
    );
  });

  it("puts a missing original before ffmpeg, whichever of them said it", () => {
    // ffmpeg reports a missing file in its own voice, and "ffmpeg could not
    // read this" is the least useful of the two true answers.
    expect(explainFailure("ffmpeg: /photos/a.mov: No such file or directory").line).toBe(
      "Roost could not open the file",
    );
  });

  it("reads a refused read as a permission problem", () => {
    expect(explainFailure("open failed on … : EACCES").line).toBe(
      "Roost is not allowed to read the file",
    );
  });

  it("falls back to a plain line rather than guessing", () => {
    const explained = explainFailure("something nobody has seen before");

    expect(explained.line).toBe("Roost could not draw this file");
    // And says where the words underneath come from, since they are all the
    // reader has to go on.
    expect(explained.hint).toContain("backend's own");
  });
});
