/**
 * The video transport, asserted against a running window (ADR-0024).
 *
 * The component tests cover the requests, the state, and the keyboard. None of
 * them can see where a mark lands along a timeline, whether the transport
 * pushes the picture off the bottom of the pane, whether a colour token exists,
 * or whether any of it moves a real decoder — happy-dom lays nothing out and
 * decodes nothing. Two of the controls do not even exist there: `fullscreen`
 * and picture-in-picture are gated on a platform capability, so a window is the
 * only place their absence can be told from their being broken.
 *
 * Builds its own library, with real video from ffmpeg, and deletes it again.
 *
 *     node scripts/check-transport.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  addComment,
  addSubtitles,
  generateMissing,
  importInto,
  Library,
  pageOf,
} from "@roost/library";
import { ledger } from "./lib/checks.mjs";
import { scratch, videoClip } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const { dir, dispose } = await scratch("check-transport");
const root = join(dir, "Check.roost");
const short = await videoClip(join(dir, "short.mp4"), { seconds: 5 });
const clip = await videoClip(join(dir, "clip.mp4"), { seconds: 20 });

const library = await Library.create(root, "Check");
try {
  // The short one first, so the commented clip is newest and the grid opens on
  // it. Two assets, because "the timeline's arrows seek instead of stepping the
  // asset" cannot be seen in a library with one.
  await importInto(library, [short]);
  await sleep(1100);
  await importInto(library, [clip]);
  // The derive pass, because frame stepping is arithmetic on the probed frame
  // rate: importing alone records neither `video.fps` nor a duration.
  await generateMissing(library);
  const hash = pageOf(library, "", { limit: 1 })[0].hash;
  await addComment(library, hash, 5000, "the cut lands early");
  await addComment(library, hash, 15_000, "hold two frames");
  await addComment(library, hash, null, "the export is 8-bit");
  // A caption track on the clip the grid opens on. Written here rather than
  // taken from a fixture file so the words under test are in one place.
  const srt = join(dir, "clip.srt");
  await writeFile(
    srt,
    "1\n00:00:01,000 --> 00:00:08,000\nthe first line, with a comma\n\n2\n00:00:09,000 --> 00:00:18,000\nthe second line\n",
    "utf8",
  );
  await addSubtitles(library, hash, [srt]);
} finally {
  await library.close();
}

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

const transportExpression = `
  (() => {
    const bar = document.querySelector(".transport");
    const video = document.querySelector("video");
    const stage = document.querySelector(".preview-stage");
    const track = document.querySelector(".transport-timeline .transport-track");
    if (bar === null || video === null || track === null) return null;
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    const thumb = document.querySelector(".transport-thumb");
    const buffered = document.querySelector(".transport-buffered");
    return {
      controls: video.hasAttribute("controls"),
      marks: [...bar.querySelectorAll(".transport-mark")].map((mark) => ({
        left: mark.style.left,
        centre: Math.round(mark.getBoundingClientRect().left + mark.getBoundingClientRect().width / 2),
        label: mark.getAttribute("aria-label"),
        // The button is the target and its ::after is the tick, so the paint
        // is on the pseudo-element and the press area is on the button.
        colour: getComputedStyle(mark, "::after").backgroundColor,
        ink: Number.parseFloat(getComputedStyle(mark, "::after").width),
        width: Math.round(mark.getBoundingClientRect().width),
      })),
      bar: box(bar),
      track: box(track),
      strip: box(document.querySelector(".transport-timeline")),
      video: box(video),
      picture: box(document.querySelector(".preview-picture")),
      stageBottom: Math.round(stage.getBoundingClientRect().bottom),
      // The floor the player stands on, which is inside the pane's gutter: the
      // bar is level with that, not with the pane's outer edge.
      stageFloor: Math.round(
        stage.getBoundingClientRect().bottom -
          Number.parseFloat(getComputedStyle(stage).paddingBottom),
      ),
      cursor: thumb === null ? null : getComputedStyle(thumb).cursor,
      valueText: thumb?.getAttribute("aria-valuetext") ?? null,
      valueNow: Number(thumb?.getAttribute("aria-valuenow") ?? Number.NaN),
      role: thumb?.getAttribute("role") ?? null,
      bufferedWidth: buffered === null ? 0 : Math.round(buffered.getBoundingClientRect().width),
      played: Math.round(document.querySelector(".transport-played")?.getBoundingClientRect().width ?? 0),
      controlNames: [...bar.querySelectorAll("button.transport-button")].map((button) => ({
        label: button.getAttribute("aria-label"),
        title: button.getAttribute("title"),
        tabbable: button.tabIndex >= 0,
      })),
      thumbTabbable: (thumb?.tabIndex ?? -1) >= 0,
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      // The panel's field, because the pane's head stopped carrying a name on
      // 2026-09-06 — the inspector had it all along.
      name: document.querySelector(".inspector-name")?.value ?? null,
      time: document.querySelector(".transport-time")?.textContent ?? null,
      rate: document.querySelector(".transport-rate")?.textContent ?? null,
      loop: (() => {
        const region = document.querySelector(".transport-loop");
        return region === null ? null : { left: region.style.left, width: region.style.width };
      })(),
    };
  })()`;

const press = async (label) =>
  cdp.evaluate(
    `[...document.querySelectorAll(".transport-button")]
      .find((button) => button.getAttribute("aria-label") === ${JSON.stringify(label)})
      .click()`,
  );

const key = (selector, name) => `
  document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
    new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true }),
  )`;

try {
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === 2);

  await cdp.evaluate(`
    (() => {
      const cell = document.querySelector(".cell");
      cell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      cell.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      cell.click();
    })()`);
  await cdp.evaluate(key(".grid", "Enter"));
  const drawn = await cdp.settle(
    transportExpression,
    (t) => t !== null && t.marks.length === 2 && Number.isFinite(t.duration),
  );

  section("What is drawn");
  check("the browser's own control bar is gone", drawn.controls === false);
  check(
    "the timeline spans the pane rather than the picture in it",
    Math.abs(drawn.bar.left - drawn.picture.left) <= 1 &&
      Math.abs(drawn.bar.right - drawn.picture.right) <= 1 &&
      drawn.bar.width > drawn.video.width,
    `bar=${drawn.bar.left}..${drawn.bar.right} picture=${drawn.picture.left}..${drawn.picture.right}`,
  );
  check(
    "it sits under the picture rather than over it",
    drawn.bar.top >= drawn.video.bottom - 1,
    `barTop=${drawn.bar.top} videoBottom=${drawn.video.bottom}`,
  );
  // Also the older check that the picture cannot push the transport off the
  // bottom: a bar level with the foot of the pane is a bar still in it.
  check(
    "the bar is at the foot of the pane, not wherever the picture ended",
    drawn.stageFloor - drawn.bar.bottom <= 2 && drawn.bar.bottom <= drawn.stageBottom,
    `barBottom=${drawn.bar.bottom} floor=${drawn.stageFloor} stage=${drawn.stageBottom}`,
  );
  check(
    "one mark per timed comment, and none for the untimed one",
    drawn.marks.length === 2,
    drawn.marks.map((m) => m.left).join(", "),
  );
  check(
    "each mark lands on its own moment along the timeline",
    drawn.marks[0]?.left === "25%" && drawn.marks[1]?.left === "75%",
    `duration=${drawn.duration}s`,
  );
  check(
    "a mark is centred on its moment rather than starting at it",
    Math.abs(drawn.marks[0].centre - (drawn.track.left + drawn.track.width / 4)) <= 2,
    `centre=${drawn.marks[0].centre} quarter=${Math.round(drawn.track.left + drawn.track.width / 4)}`,
  );
  check(
    "a mark is painted, not a declaration nothing declares",
    drawn.marks[0].colour !== "rgba(0, 0, 0, 0)" && drawn.marks[0].ink > 0,
    `${drawn.marks[0].colour} ${drawn.marks[0].ink}px`,
  );
  check(
    "a mark is pressable well past the tick drawn in it",
    drawn.marks[0].width >= drawn.marks[0].ink * 3,
    `target=${drawn.marks[0].width}px ink=${drawn.marks[0].ink}px`,
  );
  check(
    "the mark names its moment and its words",
    drawn.marks[0].label === "Play from 0:05.0: the cut lands early",
    JSON.stringify(drawn.marks[0].label),
  );
  check(
    "the pointer over the timeline is the pointer, not a web page's hand",
    drawn.cursor === "default",
    drawn.cursor,
  );
  check(
    "the strip that takes a press is several times the line drawn in it",
    drawn.bar.width > 0 && drawn.strip.height >= drawn.track.height * 3,
    `strip=${drawn.strip.height}px track=${drawn.track.height}px`,
  );
  check(
    "the elapsed and the total are both shown, to the second",
    // Nothing else and nothing finer: a frame counter stood between them until
    // 2026-09-05 and a tenth of a second until 2026-09-06, both removed at the
    // user's word. A comment's own moment keeps its tenth (ADR-0023).
    /^0:00 \/ 0:20$/.test((drawn.time ?? "").trim()),
    JSON.stringify(drawn.time),
  );

  section("What a screen reader is told (UI_SPEC.md §10)");
  check("the timeline is a slider", drawn.role === "slider", JSON.stringify(drawn.role));
  check(
    "it announces a timecode rather than a count of milliseconds",
    drawn.valueText === "0:00 of 0:20",
    JSON.stringify(drawn.valueText),
  );
  check(
    "every icon control is named, and its tooltip says the same words",
    drawn.controlNames.length >= 3 &&
      drawn.controlNames.every((c) => c.label !== null && c.label === c.title),
    drawn.controlNames.map((c) => c.label).join(", "),
  );
  check(
    "every control can be reached without a pointer",
    drawn.thumbTabbable && drawn.controlNames.every((c) => c.tabbable),
  );
  check(
    "the platform's own controls are offered where the platform has them",
    drawn.controlNames.some((c) => c.label === "Fullscreen") &&
      drawn.controlNames.some((c) => c.label === "Picture in picture"),
    drawn.controlNames.map((c) => c.label).join(", "),
  );

  section("What it does to a real decoder");
  await cdp.evaluate('document.querySelectorAll(".transport-mark")[1].click()');
  const sought = await cdp.settle(
    'document.querySelector("video").currentTime',
    (t) => Math.abs(t - 15) < 0.5,
  );
  check("clicking a mark moves the decoder", Math.abs(sought - 15) < 0.5, `t=${sought}`);

  // Autoplay means the first press is the pause, which is the half of the pair
  // that proves the button is drawn from the element rather than from a guess.
  await press("Pause");
  const held = await cdp.settle(transportExpression, (t) => t !== null && t.paused === true);
  check(
    "the button stops it, and renames itself from the element's own event",
    held.controlNames.some((c) => c.label === "Play"),
    held.controlNames.map((c) => c.label).join(", "),
  );

  await press("Play");
  const playing = await cdp.settle(transportExpression, (t) => t !== null && t.paused === false);
  check(
    "and starts it again",
    playing.controlNames.some((c) => c.label === "Pause"),
    playing.controlNames.map((c) => c.label).join(", "),
  );

  const moved = await cdp.settle(
    'document.querySelector(".transport-played").getBoundingClientRect().width',
    (width) => width > 0,
  );
  check("the played range follows the playhead", moved > 0, `${Math.round(moved)}px`);
  const bufferedNow = await cdp.evaluate(
    'Math.round(document.querySelector(".transport-buffered").getBoundingClientRect().width)',
  );
  check("what has arrived is drawn behind it", bufferedNow > 0, `${bufferedNow}px`);

  section("The keyboard");
  await cdp.evaluate(key(".preview", " "));
  const paused = await cdp.settle('document.querySelector("video").paused', (p) => p === true);
  check("Space pauses from the pane", paused === true);

  await cdp.evaluate('document.querySelector("video").currentTime = 2');
  await cdp.settle(transportExpression, (t) => t !== null && Math.abs(t.valueNow - 2000) < 200);
  await cdp.evaluate(key(".preview", "l"));
  // Settled on the *timeline*, not on the element: J and L move the playhead
  // from outside this component, and a transport that only follows the seeks it
  // made itself would sit at the old moment until something else redrew it.
  const nudged = await cdp.settle(
    transportExpression,
    (t) => t !== null && Math.abs(t.valueNow - 12_000) < 200,
  );
  check(
    "L seeks ten seconds on, and the timeline follows a seek it did not make",
    Math.abs(nudged.currentTime - 12) < 0.6,
    `t=${nudged.currentTime} timeline=${nudged.valueNow}ms`,
  );

  await cdp.evaluate(key(".preview", "m"));
  const mutedNow = await cdp.settle(transportExpression, (t) => t !== null && t.muted === true);
  check(
    "M mutes, and the button redraws from the element's own event",
    mutedNow.controlNames.some((c) => c.label === "Unmute"),
    mutedNow.controlNames.map((c) => c.label).join(", "),
  );

  // Held still first: a moving playhead makes "it moved by a step" unreadable,
  // and the claim here is about which control took the key rather than about
  // where the film is.
  const before = await cdp.settle(transportExpression, (t) => t !== null && t.paused === true);
  await cdp.evaluate('document.querySelector(".transport-thumb").focus()');
  await cdp.evaluate(key(".transport-thumb", "ArrowRight"));
  const stepped = await cdp.settle(
    transportExpression,
    (t) => t !== null && t.valueNow === before.valueNow + 100,
  );
  check(
    "the timeline's own arrows seek by a tenth of a second",
    stepped.currentTime > before.currentTime,
    `${before.valueNow}ms → ${stepped.valueNow}ms, t=${before.currentTime.toFixed(2)}→${stepped.currentTime.toFixed(2)}`,
  );
  check(
    "and the pane does not also step to the next asset",
    stepped.name === before.name,
    JSON.stringify(stepped.name),
  );

  section("What the native bar withholds (stage 2)");
  // testsrc at 10fps: a frame is a round tenth of a second, and the probe is
  // where that number comes from.
  const settleAt = (ms) =>
    cdp.settle(transportExpression, (t) => t !== null && Math.abs(t.valueNow - ms) < 60);
  await cdp.evaluate('document.querySelector("video").pause()');
  await cdp.evaluate('document.querySelector("video").currentTime = 5');
  await settleAt(5000);

  await press("Next frame");
  const oneOn = await cdp.settle(
    transportExpression,
    (t) => t !== null && Math.abs(t.currentTime - 5.1) < 0.02,
  );
  check(
    "a frame step moves exactly one frame of a real decoder",
    oneOn.paused === true,
    `t=${oneOn.currentTime.toFixed(3)} paused=${oneOn.paused}`,
  );

  await cdp.evaluate(key(".preview", ","));
  const back = await cdp.settle(
    transportExpression,
    (t) => t !== null && Math.abs(t.currentTime - 5) < 0.02,
  );
  check("and the comma key steps one back", true, `t=${back.currentTime.toFixed(3)}`);

  await cdp.evaluate(key(".preview", ">"));
  const ten = await cdp.settle(
    transportExpression,
    (t) => t !== null && Math.abs(t.currentTime - 6) < 0.02,
  );
  check("and `>` steps ten", true, `t=${ten.currentTime.toFixed(3)}`);

  // Radix opens a menu on `pointerdown`, not on `click`, so a bare `.click()`
  // leaves it shut and every assertion after it meaningless.
  await cdp.evaluate(`
    (() => {
      const trigger = document.querySelector(".transport-rate");
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    })()`);
  await cdp.settle('[...document.querySelectorAll("[role=menuitemradio]")].length', (n) => n > 0);
  await cdp.evaluate(
    `[...document.querySelectorAll("[role=menuitemradio]")]
      .find((item) => item.textContent.includes("2×"))
      .click()`,
  );
  const faster = await cdp.settle(transportExpression, (t) => t !== null && t.rate === "2×");
  check(
    "the speed menu sets the rate on the element",
    (await cdp.evaluate('document.querySelector("video").playbackRate')) === 2,
    faster.rate,
  );
  await cdp.evaluate('document.querySelector("video").playbackRate = 1');

  await cdp.evaluate('document.querySelector("video").currentTime = 5');
  await settleAt(5000);
  await cdp.evaluate(key(".preview", "i"));
  await cdp.evaluate('document.querySelector("video").currentTime = 6');
  await settleAt(6000);
  await cdp.evaluate(key(".preview", "o"));
  const looped = await cdp.settle(
    transportExpression,
    (t) => t !== null && t.loop !== null && t.loop.width !== "2px",
  );
  check(
    "the A-B loop is a region of the file, drawn where its two moments are",
    looped.loop.left === `${(5000 / 20_000) * 100}%` &&
      looped.loop.width === `${(1000 / 20_000) * 100}%`,
    `${looped.loop.left} + ${looped.loop.width}`,
  );

  // Past the end of the loop from outside it: the sampler catches it, which is
  // what makes the loop land within a frame rather than within `timeupdate`.
  await cdp.evaluate('document.querySelector("video").currentTime = 7');
  const rewound = await cdp.settle(
    'document.querySelector("video").currentTime',
    (t) => Math.abs(t - 5) < 0.2,
  );
  check("and it takes the playhead back to the start", true, `t=${rewound}`);

  section("The panel beside it");
  await cdp.evaluate('[...document.querySelectorAll("button.comment-at")][0].click()');
  const fromList = await cdp.settle(
    'document.querySelector("video").currentTime',
    (t) => Math.abs(t - 5) < 0.5,
  );
  check("a comment in the inspector still seeks the player", true, `t=${fromList}`);

  section("Subtitles (ADR-0025)");

  /*
   * Reported on 2026-09-08: a chosen `.srt` never appeared. Nothing above this
   * line could have caught it — the conversion is unit-tested, the menu is
   * component-tested, and the failure was in neither. A `<track>` is fetched
   * with CORS or not at all, and `roost:` was not a CORS-enabled scheme, so the
   * element ended at `readyState 3` with no cues, no event and no console
   * message. Which is why what is asserted here is the *cues*, in a window,
   * through the menu somebody actually presses.
   */
  // Radix opens on `pointerdown` rather than on `click`, as the speed menu
  // above already had to learn.
  const openCC = () =>
    cdp.evaluate(`
      (() => {
        const trigger = document.querySelector('.transport-button[aria-label="Subtitles"]');
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      })()`);

  await cdp.evaluate('document.querySelector("video").pause()');
  await openCC();
  await cdp.settle('[...document.querySelectorAll("[role=menuitemradio]")].length', (n) => n > 1);
  const listed = await cdp.evaluate(
    '[...document.querySelectorAll("[role=menuitemradio]")].map((item) => item.textContent)',
  );
  check(
    "the CC menu lists Off first and then the attached track",
    listed[0]?.includes("Off") === true && listed[1]?.includes("clip.srt") === true,
    listed.join(" · "),
  );

  await cdp.evaluate(
    `[...document.querySelectorAll("[role=menuitemradio]")]
      .find((item) => item.textContent.includes("clip.srt"))
      .click()`,
  );
  const shown = await cdp.settle(
    `(() => {
      const video = document.querySelector("video");
      const element = document.querySelector("video track");
      const text = video.textTracks[0];
      return {
        mode: text?.mode ?? null,
        cues: text?.cues?.length ?? 0,
        // 2 is LOADED and 3 is ERROR — the state the bug left it in.
        state: element?.readyState ?? null,
        crossOrigin: video.crossOrigin,
      };
    })()`,
    (t) => t.mode === "showing" && t.cues > 0,
    { attempts: 40 },
  );
  check(
    "choosing it loads the track rather than failing silently",
    shown.state === 2 && shown.cues === 2,
    `readyState=${shown.state} cues=${shown.cues}`,
  );
  check(
    "and the element asks for it with CORS, which is the only way a track loads",
    shown.crossOrigin === "anonymous",
    String(shown.crossOrigin),
  );

  await cdp.evaluate('document.querySelector("video").currentTime = 3');
  const active = await cdp.settle(
    `[...(document.querySelector("video").textTracks[0]?.activeCues ?? [])].map((c) => c.text)`,
    (cues) => cues.length > 0,
    { attempts: 40 },
  );
  check(
    "and the words at that moment are the words in the file",
    active[0] === "the first line, with a comma",
    JSON.stringify(active),
  );

  // Off again, so the rest of the run sees the pane it expects.
  await openCC();
  await cdp.settle('[...document.querySelectorAll("[role=menuitemradio]")].length', (n) => n > 1);
  await cdp.evaluate(
    `[...document.querySelectorAll("[role=menuitemradio]")]
      .find((item) => item.textContent.includes("Off"))
      .click()`,
  );
  const off = await cdp.settle(
    'document.querySelector("video").textTracks[0]?.mode ?? null',
    (mode) => mode === "disabled",
  );
  check("Off turns it back off", off === "disabled", String(off));

  section("Fit to window (ADR-0024 §8)");

  /*
   * The clip is 320×240 and the pane is several times that, so this is the
   * shape the user asked about on 2026-09-08: a low-resolution video adrift in
   * a big window. Only a window can answer it — the size a video is drawn at is
   * layout, and happy-dom has none.
   */
  const sizeExpression = `
    (() => {
      const video = document.querySelector("video");
      const picture = document.querySelector(".preview-picture");
      const button = [...document.querySelectorAll(".preview-fit button")][0] ?? null;
      if (video === null || picture === null) return null;
      const v = video.getBoundingClientRect();
      const p = picture.getBoundingClientRect();
      // What is actually on screen. \`object-fit: contain\` letterboxes inside
      // the element, so the element's own box is the room it was given and the
      // frame in it is the smaller of the two axes — which is the number a
      // person means by "how big is the video".
      const scale = video.videoWidth === 0
        ? 0
        : Math.min(v.width / video.videoWidth, v.height / video.videoHeight);
      return {
        video: { width: Math.round(v.width), height: Math.round(v.height) },
        picture: { width: Math.round(p.width), height: Math.round(p.height) },
        natural: { width: video.videoWidth, height: video.videoHeight },
        painted: {
          width: Math.round(video.videoWidth * scale),
          height: Math.round(video.videoHeight * scale),
        },
        pressed: button?.getAttribute("aria-pressed") ?? null,
      };
    })()`;

  const fitButton = '[...document.querySelectorAll(".preview-fit button")][0].click()';
  const settings = async () =>
    JSON.parse(await readFile(join(root, "settings.json"), "utf8").catch(() => "{}"));

  const own = await cdp.settle(sizeExpression, (s) => s !== null && s.natural.width > 0);
  check(
    "a video smaller than the pane is drawn at its own pixels, and the button is unpressed",
    own.painted.width === own.natural.width &&
      own.painted.height === own.natural.height &&
      own.pressed === "false",
    `${own.painted.width}×${own.painted.height} of ${own.picture.width}×${own.picture.height}`,
  );

  await cdp.evaluate(fitButton);
  const fitted = await cdp.settle(sizeExpression, (s) => s !== null && s.pressed === "true");
  // One axis meets the pane and the other is whatever the shape says: 4:3 in a
  // pane taller than it is wide by that ratio is bounded by the width.
  const ratio = own.natural.width / own.natural.height;
  check(
    "pressing Fit scales it up to the pane",
    (fitted.painted.width >= fitted.picture.width - 1 ||
      fitted.painted.height >= fitted.picture.height - 1) &&
      fitted.painted.width > own.painted.width,
    `${fitted.painted.width}×${fitted.painted.height} of ${fitted.picture.width}×${fitted.picture.height}`,
  );
  check(
    "keeping its shape, and inside the pane rather than over it",
    Math.abs(fitted.painted.width - fitted.painted.height * ratio) <= 2 &&
      fitted.painted.width <= fitted.picture.width + 1 &&
      fitted.painted.height <= fitted.picture.height + 1,
    `${fitted.painted.width}×${fitted.painted.height}, ratio=${ratio.toFixed(2)}`,
  );

  // In the library rather than in the window (ADR-0019): the answer is about a
  // screen, so it outlives the asset and the session.
  const remembered = await settings();
  check(
    "and remembers it in the library's own settings.json",
    remembered.fitVideoToWindow === true,
    JSON.stringify(remembered),
  );

  await cdp.evaluate(fitButton);
  const unfitted = await cdp.settle(sizeExpression, (s) => s !== null && s.pressed === "false");
  check(
    "pressing it again gives the video back its own pixels",
    unfitted.painted.width === unfitted.natural.width &&
      unfitted.painted.height === unfitted.natural.height,
    `${unfitted.painted.width}×${unfitted.painted.height}`,
  );
  const cleared = await settings();
  check("and that is remembered too", cleared.fitVideoToWindow === false, JSON.stringify(cleared));

  section("Setting this frame as the thumbnail (stage 4)");
  const cellExpression = `
    (() => {
      const cell = document.querySelector(".cell .cell-image");
      if (cell === null) return null;
      return { src: cell.getAttribute("src"), width: cell.naturalWidth, complete: cell.complete };
    })()`;

  // The loop from stage 2 is still running, and it would pull the playhead
  // back the moment this seeks past it.
  await press("Clear loop");
  await cdp.evaluate('document.querySelector("video").currentTime = 15');
  await settleAt(15_000);
  await cdp.evaluate(`
    document.querySelector(".menu-area").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    )`);
  const items = await cdp.settle(
    '[...document.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)',
    (found) => Array.isArray(found) && found.length > 0,
  );
  check(
    "the menu over a video offers the frame on screen",
    items.includes("Set this frame as the thumbnail"),
    items.join(" · "),
  );

  await cdp.evaluate(`
    [...document.querySelectorAll("[role=menuitem]")]
      .find((item) => item.textContent === "Set this frame as the thumbnail")
      .click()`);

  // Back to the grid, which is where the thumbnail is drawn.
  await cdp.evaluate(key(".preview", "Escape"));
  const cell = await cdp.settle(
    cellExpression,
    (found) => found !== null && found.src.includes("?at="),
  );
  check(
    "the cell asks for a new address, so the picture is not the cached one",
    cell.src.endsWith("@256?at=15000"),
    cell.src.slice(-24),
  );
  /*
   * The address the cell asks for, fetched here rather than read off the cell's
   * own `<img>`: the element is `loading="lazy"`, and a window that is never
   * composited never runs the observer that would start the load. What is being
   * asserted is that the new address has bytes behind it *already* — the redraw
   * happens before the reply, so the picture is never a placeholder that fills
   * in later.
   */
  const painted = await cdp.evaluate(`
    new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.naturalWidth);
      probe.onerror = () => resolve(0);
      probe.src = ${JSON.stringify(cell.src)};
    })`);
  check(
    "and the bytes behind it are there, drawn before the reply came back",
    painted > 0,
    `${painted}px`,
  );

  section("The volume the library remembers (ADR-0024 §9)");
  /*
   * The half no component test reaches: the pane makes a **new element per
   * asset**, and a new element starts at full volume unless something puts the
   * remembered one on it. happy-dom can be told a video exists; only a window
   * mounts the second one for real, and only a real run writes the file.
   */
  await cdp.evaluate(key(".grid", "Enter"));
  const reopened = await cdp.settle(transportExpression, (t) => t !== null);
  if (reopened.muted) await press("Unmute");
  await cdp.settle(transportExpression, (t) => t !== null && t.muted === false);

  // Through the slider, in the steps it actually moves in: 5% a press.
  await cdp.evaluate('document.querySelector(".transport-volume .transport-thumb").focus()');
  for (let step = 0; step < 4; step += 1) {
    await cdp.evaluate(key(".transport-volume .transport-thumb", "ArrowDown"));
  }
  const turnedDown = await cdp.settle(
    transportExpression,
    (t) => t !== null && Math.abs(t.volume - 0.8) < 0.01,
  );
  check(
    "the volume slider's arrows move it in fives",
    Math.abs(turnedDown.volume - 0.8) < 0.01,
    `volume=${turnedDown.volume}`,
  );

  const wasShowing = turnedDown.name;
  await cdp.evaluate(key(".preview", "ArrowRight"));
  const nextAsset = await cdp.settle(
    transportExpression,
    (t) => t !== null && t.name !== null && t.name !== wasShowing,
  );
  check(
    "the next asset's own element opens where the last one was left",
    Math.abs(nextAsset.volume - 0.8) < 0.01,
    `${JSON.stringify(wasShowing)} → ${JSON.stringify(nextAsset.name)} at volume=${nextAsset.volume}`,
  );

  // And on the disk, as a whole percent — the settle is the 400ms the write
  // waits for the gesture to stop.
  await sleep(900);
  const saved = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
  check(
    "and it is written to the library, in percent",
    saved.mediaVolume === 80 && saved.mediaMuted === false,
    JSON.stringify({ mediaVolume: saved.mediaVolume, mediaMuted: saved.mediaMuted }),
  );

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
}
