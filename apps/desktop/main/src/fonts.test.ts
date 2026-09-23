import { describe, expect, it } from "vitest";
import { privateFontConfig } from "./fonts.js";

/** The shape of Fedora 44's `/etc/fonts/fonts.conf`, cut to what matters here. */
const SYSTEM = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
	<dir>/usr/share/fonts</dir>
	<dir prefix="xdg">fonts</dir>
	<include ignore_missing="yes">conf.d</include>
	<cachedir>/usr/lib/fontconfig/cache</cachedir>
	<cachedir prefix="xdg">fontconfig</cachedir>
	<cachedir>~/.fontconfig</cachedir>
	<config>
		<rescan><int>30</int></rescan>
	</config>
</fontconfig>
`;

describe("the private font configuration", () => {
  it("names Roost's cache directory and no other", () => {
    // Keeping the shared directory as a second choice is not enough: the
    // newer cache is refused wherever it is found (`SETUP.md` §7).
    const config = privateFontConfig(SYSTEM, "/home/a/.cache/roost/fontconfig") ?? "";
    expect(config.match(/<cachedir\b[^>]*>[^<]*<\/cachedir>/g)).toEqual([
      "<cachedir>/home/a/.cache/roost/fontconfig</cachedir>",
    ]);
  });

  it("keeps everything else the system says", () => {
    const config = privateFontConfig(SYSTEM, "/c") ?? "";
    expect(config).toContain("<dir>/usr/share/fonts</dir>");
    expect(config).toContain('<dir prefix="xdg">fonts</dir>');
    expect(config).toContain('<include ignore_missing="yes">conf.d</include>');
    expect(config).toContain("<rescan><int>30</int></rescan>");
    expect(config.trimEnd().endsWith("</fontconfig>")).toBe(true);
  });

  it("escapes a directory that is not valid XML as it stands", () => {
    const config = privateFontConfig(SYSTEM, "/home/R&D/<x>") ?? "";
    expect(config).toContain("<cachedir>/home/R&amp;D/&lt;x&gt;</cachedir>");
  });

  it("refuses a file with no closing element", () => {
    expect(privateFontConfig("<fontconfig>", "/c")).toBeUndefined();
  });
});
