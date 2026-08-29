/**
 * A PDF small enough to write by hand, for tests.
 *
 * Committing a real document would mean committing someone's copyright and a
 * megabyte of unrelated content; generating one keeps the fixture deterministic
 * and lets a test say what colour page one is, which is the only way to check
 * that the bytes coming out of the renderer are in the channel order the
 * encoder is told to expect.
 */

/** What one page of the fixture looks like. */
export interface FixturePage {
  /** Filled edge to edge, as `[r, g, b]` from 0 to 255. */
  readonly colour: readonly [number, number, number];
}

/** Page size in points. A4 is the shape most real documents arrive in. */
export const FIXTURE_PAGE_WIDTH = 595;
export const FIXTURE_PAGE_HEIGHT = 842;

/**
 * Builds a valid single- or multi-page PDF whose pages are solid colours.
 *
 * Written as an uncompressed PDF 1.4 with an explicit cross-reference table:
 * every offset is counted from the bytes actually emitted, because a
 * cross-reference table that disagrees with the file is the one thing a lenient
 * parser will not forgive.
 */
export function makePdf(pages: readonly FixturePage[]): Buffer {
  if (pages.length === 0) throw new Error("a PDF needs at least one page");

  const objects: string[] = [];
  // 1 is the catalogue, 2 the page tree; each page then takes two objects.
  const pageIds = pages.map((_, index) => 3 + index * 2);

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
  );

  for (const [index, page] of pages.entries()) {
    const contentId = (pageIds[index] ?? 0) + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${FIXTURE_PAGE_WIDTH} ${FIXTURE_PAGE_HEIGHT}] ` +
        `/Contents ${contentId} 0 R /Resources << >> >>`,
    );
    const [r, g, b] = page.colour;
    const stream =
      `${(r / 255).toFixed(4)} ${(g / 255).toFixed(4)} ${(b / 255).toFixed(4)} rg\n` +
      `0 0 ${FIXTURE_PAGE_WIDTH} ${FIXTURE_PAGE_HEIGHT} re f\n`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }

  const chunks: Buffer[] = [];
  let offset = 0;
  const offsets: number[] = [];

  const emit = (text: string): void => {
    const bytes = Buffer.from(text, "latin1");
    chunks.push(bytes);
    offset += bytes.length;
  };

  emit("%PDF-1.4\n");
  for (const [index, body] of objects.entries()) {
    offsets.push(offset);
    emit(`${index + 1} 0 obj\n${body}\nendobj\n`);
  }

  const xref = offset;
  emit(`xref\n0 ${objects.length + 1}\n`);
  emit("0000000000 65535 f \n");
  for (const at of offsets) emit(`${String(at).padStart(10, "0")} 00000 n \n`);
  emit(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
