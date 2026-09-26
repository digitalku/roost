/**
 * Measures what a running derive queue costs everything else.
 *
 *   node --experimental-strip-types scripts/bench-contention.ts <LIBRARY>
 *     [--jobs N] [--concurrency 16,8,4] [--seconds S]
 *
 * The library must have work to do — `roost import` does not derive, so a
 * freshly imported corpus is exactly this. `roost rebuild` no longer makes it
 * so: the thumbnails survive one (ADR-0051), and the pass after it keeps them
 * rather than drawing them, which is not the load this measures. Each configuration works `--jobs`
 * of the queue, so they consume different assets from one library and the
 * mix of formats is the same for all of them.
 *
 * Two things are measured beside the derive, because the engine has two kinds
 * of neighbour. A **grid page**, run on the engine's own event loop the way an
 * `assets:page` request is, which is what a window waits on while it scrolls.
 * And a **fixed slice of CPU on another thread**, which stands in for main and
 * the renderer: they are other processes, so the event loop cannot delay them,
 * but the cores can.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { DEFAULT_PAGE_LIMIT, MATCH_LIVE } from "@roost/core";
import { enqueueMissing, Library, queueStatus, runDerives } from "@roost/library";

const { values, positionals } = parseArgs({
  options: {
    jobs: { type: "string" },
    concurrency: { type: "string" },
    seconds: { type: "string" },
  },
  allowPositionals: true,
  strict: true,
});

const root = positionals[0];
if (root === undefined) {
  console.error("usage: bench-contention.ts <LIBRARY> [--jobs N] [--concurrency 16,8,4]");
  process.exit(2);
}
const jobs = Number(values.jobs ?? 600);
const levels = (values.concurrency ?? "16,8,4,2").split(",").map(Number);
const idleSeconds = Number(values.seconds ?? 5);

/** How often a grid page is asked for, and a CPU slice taken. */
const PROBE_MS = 25;

/**
 * The neighbour thread: a fixed amount of arithmetic every tick, timed.
 *
 * Inlined rather than a file of its own so the bench stays one script. What it
 * reports is how much longer the same work took than it does on a quiet
 * machine — the renderer's frame budget is spent the same way.
 */
const NEIGHBOUR = `
const { parentPort } = require("node:worker_threads");
let samples = [];
function slice() {
  const started = performance.now();
  let x = 0;
  for (let i = 0; i < 2_000_000; i += 1) x = (x + i * 7) % 1_000_003;
  samples.push(performance.now() - started);
  if (x === -1) parentPort.postMessage("never");
}
const timer = setInterval(slice, ${PROBE_MS});
parentPort.on("message", (message) => {
  if (message === "take") { parentPort.postMessage(samples); samples = []; }
  if (message === "stop") { clearInterval(timer); parentPort.close(); }
});
`;

const library = await Library.open(root);
const neighbour = new Worker(NEIGHBOUR, { eval: true });

try {
  // What the window does on opening a library, and what makes a rebuilt one
  // measurable again.
  enqueueMissing(library);
  const queued = queueStatus(library).ready;
  console.log(`${queued} jobs queued in ${library.root}`);
  console.log(`UV_THREADPOOL_SIZE=${process.env["UV_THREADPOOL_SIZE"] ?? "(default 4)"}\n`);
  console.log(
    "  derive     jobs/s   cores   page p50   page p95   page p99   loop p99   cpu slice ×",
  );

  const quiet = await measure(async () => {
    await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));
  });
  const baseline = quiet.slice;
  print("idle", undefined, quiet, baseline);

  for (const concurrency of levels) {
    if (queueStatus(library).ready < jobs) {
      console.log(`  (stopping: fewer than ${jobs} jobs left)`);
      break;
    }
    let derived = 0;
    const result = await measure(async () => {
      const report = await runDerives(library, { limit: jobs, concurrency });
      derived = report.derived + report.blocked + report.failed + report.missing;
    });
    print(`c=${concurrency}`, derived / (result.elapsed / 1000), result, baseline);
  }
} finally {
  neighbour.postMessage("stop");
  await library.close();
}

interface Measured {
  readonly elapsed: number;
  readonly pages: number[];
  readonly loop: number;
  readonly cores: number;
  readonly slice: number;
}

/** Runs `work` while probing the event loop, the grid query, and the cores. */
async function measure(work: () => Promise<void>): Promise<Measured> {
  const filter = MATCH_LIVE;
  const pages: number[] = [];
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  neighbour.postMessage("take");
  await nextSamples();

  // Scheduled on a timer and timed from when it was *due*, so a page that
  // waited behind the event loop is charged for the wait — which is what a
  // request arriving over IPC experiences.
  let due = performance.now() + PROBE_MS;
  let probing = true;
  const probe = (): void => {
    if (!probing) return;
    library.db.repo.search(filter, { limit: DEFAULT_PAGE_LIMIT });
    pages.push(performance.now() - due);
    due = performance.now() + PROBE_MS;
    setTimeout(probe, PROBE_MS);
  };
  setTimeout(probe, PROBE_MS);

  const cpu = process.cpuUsage();
  const started = performance.now();
  await work();
  const elapsed = performance.now() - started;
  const used = process.cpuUsage(cpu);
  probing = false;
  histogram.disable();

  neighbour.postMessage("take");
  const slices = await nextSamples();
  return {
    elapsed,
    pages,
    loop: histogram.percentile(99) / 1e6,
    cores: (used.user + used.system) / 1000 / elapsed,
    slice: percentile(slices, 50),
  };
}

function nextSamples(): Promise<number[]> {
  return new Promise((resolve) => neighbour.once("message", resolve));
}

function print(label: string, rate: number | undefined, result: Measured, baseline: number): void {
  const cells = [
    label.padEnd(8),
    rate === undefined ? "       —" : rate.toFixed(0).padStart(8),
    result.cores.toFixed(1).padStart(7),
    ms(percentile(result.pages, 50)),
    ms(percentile(result.pages, 95)),
    ms(percentile(result.pages, 99)),
    ms(result.loop),
    `${(result.slice / baseline).toFixed(2)}×`.padStart(12),
  ];
  console.log(`  ${cells.join(" ")}`);
}

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`.padStart(10);
}
