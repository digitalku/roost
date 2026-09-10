/**
 * Measures what deriving costs, per format.
 *
 *   node --experimental-strip-types scripts/bench-derive.ts [--each N]
 *
 * M4 put thumbnails and metadata behind a queue because the backends differ by
 * orders of magnitude: a JPEG is a decode, a video is two process spawns, and a
 * PDF page is a WebAssembly render. One number for "thumbnails per second"
 * would average those into something true of nothing, so this reports each
 * backend separately and says which formats it could not measure.
 *
 * The corpus is generated here rather than pointed at: the sizes are what make
 * the numbers comparable between runs and between machines, and a folder of
 * somebody's photographs is neither.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { capabilities, derive, GRID_SIZE, gradient } from "@roost/media";
import { makeFont } from "@roost/media/testing/font-fixture";
import { canMakeHeic, makeHeic } from "@roost/media/testing/heic-fixture";
import { makePdf } from "@roost/media/testing/pdf-fixture";
import { makeRaw } from "@roost/media/testing/raw-fixture";

const exec = promisify(execFile);

const { values } = parseArgs({ options: { each: { type: "string" } } });
const each = Number(values.each ?? "20");

const dir = await mkdtemp(join(tmpdir(), "roost-bench-derive-"));

try {
  const all = await capabilities();
  const media = all.find((capability) => capability.name === "media");
  const hasFfmpeg = media?.available === true;
  const heif = all.find((capability) => capability.name === "heif");
  // Two questions, not one: libheif has to be able to *make* a HEIC to measure
  // (`heif-enc`) and Roost has to be able to read one (ADR-0040 §2).
  const hasHeif = heif?.available === true && (await canMakeHeic());

  const cases: { name: string; path: string }[] = [
    { name: "jpeg 4000×3000", path: await put("photo.jpg", await gradient(4000, 3000, 1, "jpeg")) },
    { name: "png 1600×1200", path: await put("shot.png", await gradient(1600, 1200, 2, "png")) },
    { name: "svg, 200 paths", path: await put("art.svg", Buffer.from(svg(200))) },
    { name: "font specimen", path: await put("face.ttf", makeFont()) },
    { name: "pdf first page", path: await put("doc.pdf", makePdf([{ colour: [40, 40, 40] }])) },
    {
      name: "raw preview",
      path: await put(
        "shot.nef",
        makeRaw({ width: 6000, height: 4000, preview: await gradient(1616, 1080, 3, "jpeg") }),
      ),
    },
  ];

  if (hasHeif) {
    // 3024×4032 is an iPhone photograph, which is the case this backend exists
    // for: 48 tiles of 512×512 that libheif has to assemble (ADR-0040).
    cases.push({ name: "heic 3024×4032", path: await makeHeic(dir, "photo.heic", 3024, 4032) });
  }

  if (hasFfmpeg) {
    cases.push(
      { name: "video frame", path: await video() },
      { name: "audio waveform", path: await audio() },
    );
  }

  console.log(`Deriving at ${GRID_SIZE}px, ${each} runs each\n`);
  console.log(`  ${"format".padEnd(20)}${"ms".padStart(8)}${"per second".padStart(14)}`);

  for (const one of cases) {
    // One run to warm the backend: a WASM module initialises once per process,
    // and charging that to the first format measured would be a lie about it.
    const warm = await derive(one.path, [GRID_SIZE]);
    if (!warm.ok) {
      console.log(`  ${one.name.padEnd(20)}${"—".padStart(8)}  ${warm.reason}`);
      continue;
    }

    const started = performance.now();
    for (let run = 0; run < each; run += 1) await derive(one.path, [GRID_SIZE]);
    const ms = (performance.now() - started) / each;

    console.log(
      `  ${one.name.padEnd(20)}${ms.toFixed(1).padStart(8)}${Math.round(1000 / ms)
        .toLocaleString()
        .padStart(14)}`,
    );
  }

  if (!hasFfmpeg) console.log(`\n  video and audio not measured: ${media?.detail ?? "no ffmpeg"}`);
  if (!hasHeif) console.log(`  heic not measured: ${heif?.detail ?? "no libheif"}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

async function put(name: string, bytes: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

/** A drawing with enough in it to cost something to rasterise. */
function svg(paths: number): string {
  const body = Array.from({ length: paths }, (_, index) => {
    const x = (index % 20) * 40;
    const y = Math.floor(index / 20) * 40;
    return `<path d="M${x} ${y} l30 8 l-6 26 l-24 -6 z" fill="hsl(${(index * 7) % 360} 60% 55%)" stroke="#222" stroke-width="1.5"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#fff"/>${body}</svg>`;
}

async function video(): Promise<string> {
  const path = join(dir, "clip.mp4");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
    "-t",
    "10",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
}

async function audio(): Promise<string> {
  const path = join(dir, "tone.mp3");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=60",
    "-c:a",
    "libmp3lame",
    path,
  ]);
  return path;
}
