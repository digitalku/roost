import {
  checkRequestEnvelope,
  type EventEnvelope,
  type ReplyEnvelope,
  type WireProblem,
} from "@roost/contract";
import { logger, toWire } from "@roost/core";
import { EngineHost } from "./host.js";
import type { Port } from "./port.js";

/**
 * The message loop: read an envelope, validate it, answer it.
 *
 * **Every message is validated here, not trusted.** Main validates the same
 * request before forwarding it, and this validates it again — not redundancy,
 * but the difference between a check and a boundary. Main is a router; this is
 * the process that holds the database.
 *
 * A message that does not validate is logged and dropped. It cannot be answered
 * with an error, because a message this malformed may not carry the id an error
 * would have to be addressed to.
 */

const log = logger("engine");

export interface Server {
  /** Emits an event to whatever is on the other end of the port. */
  emit(envelope: EventEnvelope): void;
  /** Releases the library. The port is the host's to close. */
  close(): Promise<void>;
}

export function serve(port: Port, host: EngineHost = new EngineHost()): Server {
  // The host announces a mutation; the port is what carries it. Wired here so
  // the host holds no message plumbing and can be driven straight from a test.
  host.onChanged = () => {
    port.postMessage({ event: { type: "library:changed" } } satisfies EventEnvelope);
  };
  host.onProgress = (progress) => {
    port.postMessage({ event: { type: "import:progress", ...progress } } satisfies EventEnvelope);
  };
  host.onInstallProgress = (backend, line) => {
    port.postMessage({
      event: { type: "install:progress", backend, line },
    } satisfies EventEnvelope);
  };
  host.onJobProgress = (progress) => {
    port.postMessage({ event: { type: "job:progress", ...progress } } satisfies EventEnvelope);
  };

  port.on("message", (message) => {
    const envelope = checkRequestEnvelope(message.data);
    if (!envelope.ok) {
      log.warn("dropped a message that is not a request", { reason: envelope.reason });
      return;
    }

    const { id, request } = envelope.value;
    void host
      .handle(request)
      .then((value) => reply(port, { id, ok: true, value }))
      .catch((error: unknown) => {
        // The type and the code, never the stack: a stack trace is engine
        // internals and the renderer is the process this build assumes may be
        // compromised.
        const problem = problemOf(error);
        log.warn("request failed", { request: request.type, code: problem.code });
        reply(port, { id, ok: false, problem });
      });
  });

  port.start();
  log.debug("engine listening");

  return {
    emit: (envelope) => port.postMessage(envelope),
    close: () => host.close(),
  };
}

function reply(port: Port, envelope: ReplyEnvelope): void {
  port.postMessage(envelope);
}

/**
 * An error as the wire carries it.
 *
 * `toWire` gives every `RoostError` its stable code and turns anything else
 * into `remote`, which is exactly the distinction the renderer needs: a code it
 * can act on, or one it can only report.
 */
function problemOf(error: unknown): WireProblem {
  const wire = toWire(error);
  return { code: wire.code, message: wire.message, detail: wire.detail };
}
