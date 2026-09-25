import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Placeholder } from "./Placeholder.js";

describe("what stands where a picture would be", () => {
  it("draws the kind and the extension, and nothing alarming, while nothing is known", () => {
    const { container } = render(<Placeholder kind="image" ext="heic" undrawn={null} />);

    expect(container.querySelector(".placeholder-glyph")).not.toBeNull();
    expect(container.querySelector(".cell-kind")?.textContent).toBe("heic");
    expect(container.querySelector(".placeholder-badge")).toBeNull();
  });

  it("names what to install, with the whole sentence under the pointer", () => {
    const { container } = render(
      <Placeholder kind="video" ext="mp4" undrawn="missing:decoder:hevc" />,
    );

    const badge = container.querySelector<HTMLElement>(".placeholder-badge");
    expect(badge?.textContent).toBe("No HEVC decoder");
    expect(badge?.title).toBe("The installed ffmpeg cannot decode HEVC (H.265)");
    // The attribute a row view colours the extension by, since a row has no
    // room for the badge itself.
    expect(container.querySelector(".placeholder")?.hasAttribute("data-badge")).toBe(true);
  });

  it("does not warn about a format nothing draws, which is not a fault", () => {
    // `CONCEPT.md` §5: a `.zip` without a picture is what a library that
    // holds anything looks like.
    const { container } = render(<Placeholder kind="other" ext="zip" undrawn="unsupported:zip" />);

    expect(container.querySelector(".placeholder-badge")).toBeNull();
    expect(container.querySelector(".placeholder")?.hasAttribute("data-badge")).toBe(false);
  });

  it("calls a file with no extension a file", () => {
    const { container } = render(<Placeholder kind="other" ext="" undrawn={null} />);
    expect(container.querySelector(".cell-kind")?.textContent).toBe("file");
  });
});
