import { describe, expect, it } from "vitest";
import { bytes, counted } from "./format.js";

describe("counting in the interface's own language", () => {
  it("groups in English whatever the machine is set to", () => {
    // The assertion that matters, and the one a passing CI cannot make on its
    // own: with the locale left to the machine this reads "1.234" on a machine
    // set to Indonesian, and an English sentence saying "1.234 assets" says one
    // and a bit (UI_SPEC.md §2.3).
    const machine = (1234).toLocaleString();
    expect(counted(1234)).toBe("1,234");
    expect(counted(1234)).toBe((1234).toLocaleString("en-US"));
    if (machine !== "1,234") expect(counted(1234)).not.toBe(machine);
  });

  it("leaves small numbers alone and carries every group", () => {
    expect(counted(0)).toBe("0");
    expect(counted(999)).toBe("999");
    expect(counted(1_000_000)).toBe("1,000,000");
  });
});

describe("counting bytes", () => {
  it("uses binary multiples, as the storage spec does", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1024)).toBe("1.0 KiB");
    expect(bytes(1024 * 1024 * 3)).toBe("3.0 MiB");
  });
});
