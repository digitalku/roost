import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rm, statfs, utimes } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  checkRequest,
  type Event,
  type Outcome,
  type Request,
  type WireReceived,
} from "@roost/contract";
import { logger, makeDirectoryInside, STAGING_DIR } from "@roost/core";
import { addressesToType, isLocalAddress } from "./addresses.js";
import { REMOTE_EVENTS, REMOTE_REQUESTS } from "./allowed.js";
import { type Device, DeviceStore } from "./devices.js";

const log = logger("remote");

/** The API's version, in every route's path (`REMOTE.md` RR-2). */
export const REMOTE_API_VERSION = 1;

/** ADR-0072 §3.7. Unassigned by IANA, and easy to say. */
export const DEFAULT_REMOTE_PORT = 7387;

/** A JSON body larger than this is not a request this build sends. */
const MAX_BODY = 1024 * 1024;

/** Server-sent events need traffic now and then, or a proxy or a phone gives up on them. */
const HEARTBEAT_MS = 25_000;

/** ADR-0073 §3.4: what an upload must leave free on the library's filesystem. */
export const UPLOAD_MARGIN = 1024 ** 3;

/** The longest file name most filesystems take, in bytes. */
const MAX_NAME_BYTES = 255;

/** ADR-0072 §3.5: five wrong passwords in a minute, and a minute of refusals. */
const PAIR_FAILURES = 5;
const PAIR_WINDOW_MS = 60_000;

/** What main gives the server: the same doors a window has. */
export interface SharingHost {
  /** The build's version, for `hello`. */
  readonly build: string;
  /** Answers a request exactly as a window's is answered. */
  answer(request: Request): Promise<Outcome<unknown>>;
  /** Answers a `roost://` request, as `protocol.handle` does. */
  bytes(request: globalThis.Request): Promise<globalThis.Response>;
  /** Whether `password` is the open library's (the engine's check, RL-5c). */
  checkPassword(password: string): Promise<boolean>;
  /** Imports a file staged in the library's `staging/` (ADR-0073 §3.5). */
  receive(path: string, folder: number | null): Promise<Outcome<WireReceived>>;
}

/** The library the window holds, as far as sharing needs to know it. */
export interface SharedLibrary {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly hasPassword: boolean;
}

export interface SharingOptions {
  /** Where this machine keeps its devices: `stateDir()` in the application. */
  readonly stateDir: string;
  readonly port?: number;
  /** Unix seconds. Replaced by tests. */
  readonly now?: () => number;
  /** Free bytes on the library's filesystem. Replaced by tests. */
  readonly freeSpace?: (root: string) => Promise<number>;
}

/** What the window's dialog draws (ADR-0072 §3.1). */
export interface SharingStatus {
  /** The box is ticked for this library. */
  readonly sharing: boolean;
  /** A phone could reach it now. */
  readonly listening: boolean;
  readonly hasPassword: boolean;
  readonly port: number;
  /** What to type into the phone. */
  readonly addresses: readonly string[];
  /** Why it is ticked and not listening, said for a person. */
  readonly problem: string | null;
  readonly devices: readonly Device[];
}

interface Stream {
  readonly response: ServerResponse;
  readonly device: string;
}

/**
 * Sharing the open library on the local network (ADR-0072).
 *
 * It listens while three things are true — a library is open, it has a
 * password, and its box is ticked — and at no other time, so a window that
 * never ticks it opens no socket (invariant 7). The routes are `REMOTE.md`'s.
 * Everything a phone asks reaches the engine through the same `checkRequest`
 * a window's does, and then through an allowlist of its own.
 */
export class LibrarySharing {
  readonly #host: SharingHost;
  readonly #stateDir: string;
  readonly #port: number;
  readonly #now: () => number;
  readonly #freeSpace: (root: string) => Promise<number>;

  #library: SharedLibrary | undefined;
  #store: DeviceStore | undefined;
  #server: Server | undefined;
  #problem: string | null = null;
  readonly #streams = new Set<Stream>();
  readonly #failures = new Map<string, number[]>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #changing: Promise<unknown> = Promise.resolve();
  /** Received files are imported one at a time (ADR-0073 §3.5). */
  #receiving: Promise<unknown> = Promise.resolve();

  constructor(host: SharingHost, options: SharingOptions) {
    this.#host = host;
    this.#stateDir = options.stateDir;
    this.#port = options.port ?? DEFAULT_REMOTE_PORT;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#freeSpace = options.freeSpace ?? freeSpace;
  }

  /** One change at a time: a close and an open arriving together must not interleave. */
  #serially<T>(change: () => Promise<T>): Promise<T> {
    const next = this.#changing.then(change, change);
    this.#changing = next.catch(() => undefined);
    return next;
  }

  /**
   * The window opened, renamed or closed a library, or changed its password.
   * `undefined` when none is open.
   */
  follow(library: SharedLibrary | undefined): Promise<SharingStatus> {
    return this.#serially(async () => {
      if (library?.id !== this.#library?.id) {
        this.#endStreams();
        await this.#store?.settled();
        this.#store =
          library === undefined ? undefined : new DeviceStore(this.#stateDir, library.id);
      }
      this.#library = library;
      await this.#reconcile();
      return this.#status();
    });
  }

  status(): Promise<SharingStatus> {
    return this.#serially(() => this.#status());
  }

  /** Ticks or unticks the box for the open library. */
  share(on: boolean): Promise<SharingStatus> {
    return this.#serially(async () => {
      if (this.#store === undefined) return this.#status();
      await this.#store.setSharing(on);
      await this.#reconcile();
      return this.#status();
    });
  }

  /** Unpairs a device, and closes whatever it has open. */
  revoke(device: string): Promise<SharingStatus> {
    return this.#serially(async () => {
      if ((await this.#store?.revoke(device)) === true) {
        for (const stream of [...this.#streams]) {
          if (stream.device === device) this.#endStream(stream);
        }
      }
      return this.#status();
    });
  }

  /** Passes an engine event to the phones listening for it. */
  emit(event: Event): void {
    if (!REMOTE_EVENTS.has(event.type)) return;
    const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.#streams) stream.response.write(line);
  }

  /** Stops listening, for a quit. The box stays ticked. */
  stop(): Promise<void> {
    return this.#serially(async () => {
      await this.#close();
      await this.#store?.settled();
    });
  }

  /** The port listened on: the one asked for, or the one given for port 0. */
  #bound(): number {
    const address = this.#server?.address();
    return typeof address === "object" && address !== null ? address.port : this.#port;
  }

  async #status(): Promise<SharingStatus> {
    const library = this.#library;
    const port = this.#bound();
    return {
      sharing: (await this.#store?.sharing()) ?? false,
      listening: this.#server !== undefined,
      hasPassword: library?.hasPassword ?? false,
      port,
      addresses: this.#server === undefined ? [] : addressesToType(port),
      problem: this.#problem,
      devices: (await this.#store?.devices()) ?? [],
    };
  }

  async #reconcile(): Promise<void> {
    const want =
      this.#library !== undefined &&
      this.#library.hasPassword &&
      (await this.#store?.sharing()) === true;
    if (want && this.#server === undefined) await this.#listen();
    if (!want && this.#server !== undefined) await this.#close();
    if (!want) this.#problem = null;
  }

  async #listen(): Promise<void> {
    const server = createServer((request, response) => {
      void this.#route(request, response).catch((error: unknown) => {
        log.error("a remote request failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        if (!response.headersSent) problem(response, 500, "remote", "The request failed");
        else response.end();
      });
    });
    // Every connection, before a byte of it is read: an address on the
    // internet gets nothing, not even a refusal (ADR-0072 §3.7).
    server.on("connection", (socket) => {
      if (!isLocalAddress(socket.remoteAddress)) socket.destroy();
    });
    // Node ends a request that has not arrived in five minutes, and a video
    // from a phone can take longer than that over Wi-Fi (ADR-0073). Only a
    // paired device gets as far as sending a body, and the headers keep their
    // own limit.
    server.requestTimeout = 0;
    try {
      await listen(server, this.#port, "::").catch((error: NodeJS.ErrnoException) => {
        // A machine with IPv6 turned off cannot bind `::`; IPv4 is enough.
        if (error.code !== "EAFNOSUPPORT" && error.code !== "EADDRNOTAVAIL") throw error;
        return listen(server, this.#port, "0.0.0.0");
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.#problem =
        code === "EADDRINUSE"
          ? `Port ${this.#port} is in use by another program.`
          : `Could not listen on port ${this.#port} (${code ?? "unknown"}).`;
      log.warn("sharing could not start", { port: this.#port, code: code ?? "unknown" });
      return;
    }
    this.#server = server;
    this.#problem = null;
    this.#heartbeat = setInterval(() => {
      for (const stream of this.#streams) stream.response.write(": ping\n\n");
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
    log.info("sharing on the local network", { port: this.#port });
  }

  async #close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#endStreams();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    log.info("stopped sharing");
  }

  #endStreams(): void {
    for (const stream of [...this.#streams]) this.#endStream(stream);
  }

  #endStream(stream: Stream): void {
    this.#streams.delete(stream);
    stream.response.end();
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://remote");
    const path = url.pathname;
    const method = request.method ?? "GET";
    const api = `/api/${REMOTE_API_VERSION}`;

    if (path === `${api}/hello` && method === "GET") return this.#hello(response);
    if (path === `${api}/pair` && method === "POST") return this.#pair(request, response);

    const library = this.#library;
    const store = this.#store;
    const key = library === undefined ? null : await passwordKey(library.root);
    if (library === undefined || store === undefined || key === null) {
      return problem(response, 503, "not_shared", "No library is shared here now");
    }
    const token = bearer(request);
    const device = token === undefined ? undefined : await store.verify(token, key, this.#now());
    if (device === undefined) {
      return problem(response, 401, "not_paired", "This device is not paired, or was unpaired");
    }

    if (path === `${api}/request` && method === "POST") return this.#request(request, response);
    if (path === `${api}/upload` && method === "POST") {
      return this.#upload(request, response, url, library.root);
    }
    if (path === `${api}/events` && method === "GET") return this.#events(response, device);
    if (path.startsWith("/bytes/") && (method === "GET" || method === "HEAD")) {
      return this.#bytes(request, response, url);
    }
    return problem(response, 404, "not_found", "No such route");
  }

  #hello(response: ServerResponse): void {
    const library = this.#library;
    json(response, 200, {
      api: REMOTE_API_VERSION,
      build: this.#host.build,
      library: library === undefined ? null : { id: library.id, name: library.name },
      // REMOTE.md revision 1.1: a client shows its button only where this is.
      upload: true,
    });
  }

  async #pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recent = (this.#failures.get(address) ?? []).filter((at) => now - at < PAIR_WINDOW_MS);
    this.#failures.set(address, recent);
    if (recent.length >= PAIR_FAILURES) {
      return problem(response, 429, "too_many_attempts", "Too many wrong passwords; wait a minute");
    }

    const body = await readJson(request);
    if (body === undefined) return problem(response, 400, "invalid_request", "Not JSON");
    const password = Reflect.get(body, "password");
    const name = Reflect.get(body, "device");
    if (typeof password !== "string" || password === "") {
      return problem(response, 400, "invalid_request", "password: expected a string");
    }
    if (typeof name !== "string" || name.trim() === "" || name.length > 64) {
      return problem(response, 400, "invalid_request", "device: expected a name of 1 to 64");
    }

    const library = this.#library;
    const store = this.#store;
    const key = library === undefined ? null : await passwordKey(library.root);
    if (library === undefined || store === undefined || key === null) {
      return problem(response, 503, "not_shared", "No library is shared here now");
    }
    if (!(await this.#host.checkPassword(password))) {
      recent.push(now);
      log.warn("a device gave a wrong password", { address });
      return problem(response, 403, "password_wrong", "That is not the password");
    }
    this.#failures.delete(address);
    const paired = await store.pair(name.trim(), key, this.#now());
    json(response, 200, { token: paired.token, device: paired.device });
  }

  async #request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    if (body === undefined) return problem(response, 400, "invalid_request", "Not JSON");
    const checked = checkRequest(body);
    if (!checked.ok) return problem(response, 400, "invalid_request", checked.reason);
    if (!REMOTE_REQUESTS.has(checked.value.type)) {
      return problem(
        response,
        403,
        "not_allowed_remotely",
        `${checked.value.type} is not answered away from this machine`,
      );
    }
    json(response, 200, await this.#host.answer(checked.value));
  }

  /**
   * One file, its bytes the body (ADR-0073 §3.1). Streamed into `staging/`,
   * imported from there by a move, and the staging directory removed whatever
   * the answer was.
   */
  async #upload(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    root: string,
  ): Promise<void> {
    // A refusal sent before the body is read: the client is still sending, so
    // the connection goes with the answer rather than being reused.
    const refuse = (status: number, code: string, message: string): void => {
      response.setHeader("connection", "close");
      problem(response, status, code, message);
    };

    const name = uploadName(url.searchParams.get("name"));
    if (name === undefined) return refuse(400, "invalid_request", "name: expected a file name");
    const folder = positive(url.searchParams.get("folder"));
    if (folder === undefined) return refuse(400, "invalid_request", "folder: expected a folder id");
    const modified = moment(url.searchParams.get("modified"));
    if (modified === undefined) return refuse(400, "invalid_request", "modified: expected ms");

    const header = request.headers["content-length"];
    const length = header !== undefined && /^\d+$/.test(header) ? Number(header) : undefined;
    if (length === undefined || request.headers["transfer-encoding"] !== undefined) {
      return refuse(411, "length_required", "The file's length is needed first");
    }
    if (length > (await this.#freeSpace(root)) - UPLOAD_MARGIN) {
      return refuse(507, "no_space", "There is not enough free space on the library's disk");
    }

    const directory = join(root, STAGING_DIR, `upload-${randomUUID()}`);
    let answer: Outcome<WireReceived> | undefined;
    try {
      answer = await this.#receive(request, directory, name, length, modified, folder, root);
    } finally {
      // Before the answer, so that nothing is left behind once it has arrived.
      await rm(directory, { recursive: true, force: true });
    }
    // `undefined`: the phone left before its last byte, and nobody is listening.
    if (answer !== undefined) json(response, 200, answer);
  }

  /** The body into `staging/`, and the file handed to main to import. */
  async #receive(
    request: IncomingMessage,
    directory: string,
    name: string,
    length: number,
    modified: number | null,
    folder: number | null,
    root: string,
  ): Promise<Outcome<WireReceived> | undefined> {
    // Through `makeDirectoryInside`, so a library whose folder was renamed
    // under it gets no new directory at its old path (ADR-0056).
    await makeDirectoryInside(root, directory);
    const path = join(directory, name);
    let arrived = 0;
    request.on("data", (chunk: Buffer) => {
      arrived += chunk.length;
    });
    try {
      await pipeline(request, createWriteStream(path, { flags: "wx" }));
    } catch {
      log.info("an upload ended before its last byte", { arrived, length });
      return undefined;
    }
    if (arrived !== length) {
      log.info("an upload ended before its last byte", { arrived, length });
      return undefined;
    }
    if (modified !== null) await utimes(path, modified / 1000, modified / 1000);

    // From here the import runs to the end, answered or not: a placed file is
    // a committed file (ADR-0055).
    const next = this.#receiving.then(() => this.#host.receive(path, folder));
    this.#receiving = next.catch(() => undefined);
    return next;
  }

  #events(response: ServerResponse, device: Device): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    const stream: Stream = { response, device: device.id };
    this.#streams.add(stream);
    response.on("close", () => this.#streams.delete(stream));
  }

  async #bytes(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    // `/bytes/thumb/<id>@256` is `roost://thumb/<id>@256`, the path the window
    // asks for, so the byte server answers both the same way (ADR-0008).
    const headers = new Headers();
    for (const name of ["range", "if-none-match", "if-modified-since"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const answer = await this.#host.bytes(
      new globalThis.Request(`roost://${url.pathname.slice("/bytes/".length)}${url.search}`, {
        method: request.method ?? "GET",
        headers,
      }),
    );
    const out: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      out[name] = value;
    });
    response.writeHead(answer.status, out);
    if (answer.body === null || request.method === "HEAD") {
      response.end();
      return;
    }
    // The cast names the same stream by its Node type: `Response.body` is
    // typed from the DOM's lib and `fromWeb` from `node:stream/web`'s.
    Readable.fromWeb(answer.body as unknown as NodeReadableStream<Uint8Array>).pipe(response);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      server.removeListener("listening", done);
      reject(error);
    };
    const done = (): void => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", done);
    server.listen(port, host);
  });
}

/**
 * The open library's password, as `library.json` holds it, or `null` when it
 * has none (RL-5c).
 *
 * Read at every request rather than remembered, because it is what decides
 * whether a device's token still counts: a password changed by any process,
 * the CLI included, unpairs every device at the next request.
 */
async function passwordKey(root: string): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, "library.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null) return null;
    const record = Reflect.get(manifest, "password");
    if (typeof record !== "object" || record === null) return null;
    const hash = Reflect.get(record, "hash");
    return typeof hash === "string" && hash !== "" ? hash : null;
  } catch {
    return null;
  }
}

async function freeSpace(root: string): Promise<number> {
  const stats = await statfs(root);
  return stats.bavail * stats.bsize;
}

/**
 * The name a phone gave its file, if it can be a file's name in one directory:
 * no separator, no NUL, not `.` or `..`, and short enough for the filesystem.
 * RL-36's normalisation is the importer's, as for every name.
 */
export function uploadName(name: string | null): string | undefined {
  if (name === null) return undefined;
  if (name.trim() === "" || name === "." || name === "..") return undefined;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined;
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return undefined;
  return name;
}

/** A folder id, `null` when absent, `undefined` when it is not one. */
function positive(value: string | null): number | null | undefined {
  if (value === null) return null;
  if (!/^[1-9]\d{0,15}$/.test(value)) return undefined;
  return Number(value);
}

/** Milliseconds since the epoch, `null` when absent, `undefined` when not one. */
function moment(value: string | null): number | null | undefined {
  if (value === null) return null;
  if (!/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  const match = header === undefined ? null : /^Bearer ([0-9a-f]{64})$/i.exec(header);
  return match?.[1]?.toLowerCase();
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function problem(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { ok: false, problem: { code, message, detail: {} } });
}
