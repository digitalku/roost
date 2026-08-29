import { fileURLToPath } from "node:url";
import {
  checkEventEnvelope,
  checkReplyEnvelope,
  type Event,
  type Request,
  type WireProblem,
} from "@roost/contract";
import { logger, threadPoolEnv } from "@roost/core";
import { type UtilityProcess, utilityProcess } from "electron";

/**
 * Main's half of the engine conversation (ADR-0006).
 *
 * The engine runs in its own `utilityProcess` because `better-sqlite3` blocks
 * the thread it runs on, and main has two jobs that must never stall: window
 * events, and answering `roost://` during a 60fps scroll.
 *
 * Main is a router. It validates what the renderer sends before forwarding it
 * and validates what the engine sends back before passing it on, and it holds
 * no library state of its own — asking the engine is always cheaper than
 * keeping a second copy of the answer in step.
 */

const log = logger("main");

/**
 * Where the engine's entry point sits relative to this file.
 *
 * Resolved from `import.meta.url` rather than from the working directory, which
 * is whatever the user launched from. A packaged build relocates both, and
 * `TODO.md` records that as M6 work.
 */
const ENGINE_ENTRY = fileURLToPath(new URL("../../engine/dist/engine.js", import.meta.url));

/** A request rejected because the process that would have answered it is gone. */
export class EngineGoneError extends Error {
  readonly problem: WireProblem;

  constructor(reason: string) {
    super(reason);
    this.name = "EngineGoneError";
    this.problem = { code: "remote", message: reason, detail: {} };
  }
}

export class Engine {
  readonly #onEvent: (event: Event) => void;
  readonly #pending = new Map<number, PendingRequest>();
  #child: UtilityProcess | undefined;
  #nextId = 1;
  #stopping = false;

  constructor(onEvent: (event: Event) => void) {
    this.#onEvent = onEvent;
  }

  /** Starts the engine if it is not already running. */
  start(): void {
    if (this.#child !== undefined) return;

    // A separate process needs its own inspector port; main's does not reach it
    // (`SETUP.md` §5). Off unless asked for, because an open port is a thing
    // that should be asked for.
    const inspect = process.env["ROOST_ENGINE_INSPECT"];
    const execArgv = inspect === undefined || inspect === "" ? [] : [inspectFlag(inspect)];

    // stdio inherited: the engine logs to stderr, and a crash is read from the
    // same terminal as everything else.
    const child = utilityProcess.fork(ENGINE_ENTRY, [], {
      serviceName: "roost-engine",
      stdio: "inherit",
      execArgv,
      // The one place the decoder's threadpool can be sized: libuv reads
      // `UV_THREADPOOL_SIZE` once, on the way up, so a process cannot widen its
      // own — measured, in `threadpool.ts`. The engine is the process that
      // decodes, and this is where it is started.
      env: threadPoolEnv(),
    });
    if (execArgv.length > 0) log.info("engine inspector", { flag: execArgv[0] ?? "" });
    this.#child = child;

    child.on("message", (message: unknown) => this.#receive(message));
    child.on("exit", (code) => this.#exited(code));
    // Logged on `spawn` rather than after `fork`: the pid does not exist yet at
    // the point fork returns, and a log line saying -1 is worse than none.
    child.on("spawn", () => log.info("engine started", { pid: child.pid ?? 0 }));
  }

  /**
   * Sends a request and waits for its reply.
   *
   * There is no timeout, deliberately. A rebuild of a million-line journal is a
   * legitimate multi-minute request, and a timer that cancelled it would turn a
   * slow answer into a wrong one. What ends a wait is the engine exiting, which
   * rejects everything outstanding at once.
   */
  request(request: Request): Promise<unknown> {
    this.start();
    const child = this.#child;
    if (child === undefined) {
      return Promise.reject(new EngineGoneError("the engine could not be started"));
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      child.postMessage({ id, request });
    });
  }

  /** Stops the engine, giving it the chance to close its library first. */
  stop(): void {
    this.#stopping = true;
    this.#child?.kill();
    this.#child = undefined;
  }

  #receive(message: unknown): void {
    // An event and a reply arrive on the same channel, and an event has no id.
    const event = checkEventEnvelope(message);
    if (event.ok) {
      this.#onEvent(event.value.event);
      return;
    }

    const reply = checkReplyEnvelope(message);
    if (!reply.ok) {
      log.warn("dropped a message from the engine", { reason: reply.reason });
      return;
    }

    const pending = this.#pending.get(reply.value.id);
    if (pending === undefined) {
      // A reply to a request nobody is waiting for: the engine restarted, or
      // this is a second reply to one id. Neither is actionable, both are worth
      // seeing.
      log.warn("reply with no request waiting", { id: reply.value.id });
      return;
    }

    this.#pending.delete(reply.value.id);
    if (reply.value.ok) pending.resolve(reply.value.value);
    else pending.reject(new EngineProblem(reply.value.problem));
  }

  #exited(code: number): void {
    log.warn("engine exited", { code, stopping: this.#stopping, pending: this.#pending.size });
    this.#child = undefined;

    // Everything outstanding fails now rather than waiting forever for a
    // process that is gone. The next request starts a fresh engine; an import
    // interrupted this way is resumable, because content hashing makes
    // re-import idempotent (ADR-0006).
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of waiting) {
      pending.reject(new EngineGoneError(`the engine exited with code ${code}`));
    }
  }
}

/** An error the engine reported, carrying the code it chose. */
export class EngineProblem extends Error {
  readonly problem: WireProblem;

  constructor(problem: WireProblem) {
    super(problem.message);
    this.name = "EngineProblem";
    this.problem = problem;
  }
}

/**
 * `ROOST_ENGINE_INSPECT=1` picks a port; anything else is taken as the port.
 *
 * 9230 rather than 9229, which is where main's own inspector sits — two
 * processes cannot share one, and the failure is a silent "cannot connect".
 */
function inspectFlag(value: string): string {
  return value === "1" ? "--inspect=9230" : `--inspect=${value}`;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}
