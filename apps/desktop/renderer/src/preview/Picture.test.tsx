import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fakeDetail } from "../testing/fake-engine.js";
import { fitScale, Picture, percent, placeOffset, zoomAbout } from "./Picture.js";

/**
 * The picture, and the arithmetic under it.
 *
 * happy-dom computes no layout and loads no bytes, so the geometry is tested as
 * the functions it is made of and the component tests drive what is left: which
 * control is live, and what the wheel does to the scale. Where the two meet —
 * a real photograph in a real pane — is `scripts/check-preview.mjs`.
 */

const DETAIL = fakeDetail(1, { name: "one.png", kind: "image" });

/**
 * The picture and the slot its controls are drawn into.
 *
 * The same arrangement the pane has: the zoom bar belongs to the picture and is
 * drawn in the head, a portal away from it (`UI_SPEC.md` §7). A test that
 * rendered the component alone would be testing something with no controls.
 */
function Harness(): React.JSX.Element {
  const [tools, setTools] = useState<HTMLElement | null>(null);
  return (
    <>
      <div ref={setTools} />
      <Picture detail={DETAIL} src="roost://original/one" controls={tools} />
    </>
  );
}

/** Loads the picture with a natural size, which no browserless DOM will do. */
function loads(width: number, height: number): void {
  const image = screen.getByRole("img", { name: "one.png" });
  Object.defineProperty(image, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(image, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(image);
}

const level = (): string =>
  screen.getByRole("button", { name: /Fit to the pane|Zoom to actual size/ }).textContent ?? "";

describe("fitting a picture to a pane", () => {
  it("takes the tighter of the two axes", () => {
    expect(fitScale({ width: 4000, height: 1000 }, { width: 800, height: 800 })).toBe(0.2);
    expect(fitScale({ width: 1000, height: 4000 }, { width: 800, height: 800 })).toBe(0.2);
  });

  it("never blows a small picture up: a 64px icon opens at 64px", () => {
    expect(fitScale({ width: 64, height: 64 }, { width: 800, height: 800 })).toBe(1);
  });

  it("answers 1 before anything has been measured, rather than 0 or Infinity", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 800 })).toBe(1);
    expect(fitScale({ width: 4000, height: 4000 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("where the picture sits", () => {
  const box = { width: 800, height: 600 };

  it("centres an axis smaller than the pane, whatever it was asked for", () => {
    // A photograph that can be dragged into a corner of an empty pane is one
    // somebody has to put back.
    expect(placeOffset({ width: 400, height: 300 }, box, { x: -900, y: 900 })).toEqual({
      x: 200,
      y: 150,
    });
  });

  it("clamps a larger axis to its own edges, so the pane is never left blank", () => {
    expect(placeOffset({ width: 2000, height: 1200 }, box, { x: 500, y: -5000 })).toEqual({
      x: 0,
      y: -600,
    });
  });
});

describe("zooming about a point", () => {
  it("keeps the pixel under the pointer under the pointer", () => {
    // The picture sits at the origin at 1×; the point 100px in is the point
    // 100px into the image. At 2× that same image point is 200px in, so the
    // offset has to move back by 100 for it to stay under the cursor.
    expect(zoomAbout({ x: 100, y: 50 }, { x: 0, y: 0 }, 1, 2)).toEqual({ x: -100, y: -50 });
  });

  it("is its own inverse, so a wheel back leaves the picture where it was", () => {
    const out = zoomAbout({ x: 137, y: 41 }, { x: -60, y: -20 }, 1, 2.5);
    expect(zoomAbout({ x: 137, y: 41 }, out, 2.5, 1)).toEqual({ x: -60, y: -20 });
  });
});

describe("the zoom control", () => {
  it("says the scale, and starts at the fit", async () => {
    render(<Harness />);
    loads(1600, 1200);
    expect(level()).toBe("100%");
    // Nothing to zoom out to: the fit is the floor, and this picture is at it.
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("steps up and down again from the buttons", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    loads(1600, 1200);

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(level()).toBe("125%");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(level()).toBe("156%");

    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(level()).toBe("125%");
  });

  it("goes back to the fit from the readout, and not below it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    loads(1600, 1200);

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await user.click(screen.getByRole("button", { name: "Fit to the pane" }));
    expect(level()).toBe("100%");

    // The floor is the fit, not a picture shrunk into the middle of the pane.
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(level()).toBe("100%");
  });

  it("zooms on the wheel, in both directions", () => {
    render(<Harness />);
    loads(1600, 1200);
    const viewport = screen.getByRole("img", { name: "one.png" }).parentElement;
    if (viewport === null) throw new Error("the picture has no viewport");

    // Up the way a wheel reports it: a negative deltaY is towards the screen.
    fireEvent.wheel(viewport, { deltaY: -200, clientX: 0, clientY: 0 });
    expect(level()).toBe("135%");

    fireEvent.wheel(viewport, { deltaY: 200, clientX: 0, clientY: 0 });
    expect(level()).toBe("100%");
  });
});

describe("the readout", () => {
  it("is whole percent, because nobody is reading tenths", () => {
    expect(percent(1)).toBe("100%");
    expect(percent(0.20408)).toBe("20%");
    expect(percent(16)).toBe("1600%");
  });
});
