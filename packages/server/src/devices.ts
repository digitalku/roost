import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@roost/core";

const log = logger("remote");

/** A phone paired with one library on this machine (ADR-0072 §3.5). */
export interface Device {
  readonly id: string;
  readonly name: string;
  /** Unix seconds. */
  readonly pairedAt: number;
  /** Unix seconds, or `null` until its first request after pairing. */
  readonly lastSeen: number | null;
}

interface StoredDevice extends Device {
  /** SHA-256 of the token, hex. The token itself is never kept. */
  readonly token: string;
  /** SHA-256 of the library password's hash it was paired under, hex. */
  readonly password: string;
}

interface Stored {
  readonly sharing: boolean;
  readonly devices: readonly StoredDevice[];
}

const EMPTY: Stored = { sharing: false, devices: [] };

/** A device's last-seen time is written at most this often, in seconds. */
const SEEN_EVERY = 60;

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * What this machine remembers about sharing one library: whether the box is
 * ticked, and the devices paired with it.
 *
 * **This machine's state, not the library's** (ADR-0072 §3.5). A copied
 * library lets no old phone in elsewhere and starts listening nowhere by
 * itself, and nothing is written into the library (RL-3). One file per
 * library, named by a hash of its id: the id comes from `library.json`, which
 * anybody may have edited, and it is about to become a file name.
 */
export class DeviceStore {
  readonly #path: string;
  #stored: Stored = EMPTY;
  #loaded = false;
  #writing: Promise<void> = Promise.resolve();

  constructor(stateDir: string, libraryId: string) {
    this.#path = join(stateDir, "remote", `${hash(libraryId).slice(0, 32)}.json`);
  }

  async #load(): Promise<Stored> {
    if (this.#loaded) return this.#stored;
    this.#loaded = true;
    try {
      this.#stored = parseStored(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      // Absent is the ordinary first time. Damaged is reported and read as
      // nothing, which unpairs every device rather than guessing at a token.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("the paired devices could not be read; starting with none", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
      this.#stored = EMPTY;
    }
    return this.#stored;
  }

  /** Written beside and renamed into place, one write at a time. */
  #save(next: Stored): Promise<void> {
    this.#stored = next;
    const write = async (): Promise<void> => {
      const temporary = `${this.#path}.${randomUUID()}`;
      await mkdir(join(this.#path, ".."), { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.#path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    this.#writing = this.#writing.then(write, write);
    return this.#writing;
  }

  async sharing(): Promise<boolean> {
    return (await this.#load()).sharing;
  }

  async setSharing(on: boolean): Promise<void> {
    const stored = await this.#load();
    if (stored.sharing !== on) await this.#save({ ...stored, sharing: on });
  }

  async devices(): Promise<Device[]> {
    return (await this.#load()).devices.map(({ id, name, pairedAt, lastSeen }) => ({
      id,
      name,
      pairedAt,
      lastSeen,
    }));
  }

  /**
   * Pairs a device under the library's current password, and answers with
   * the token: the only time it exists anywhere but on the phone.
   */
  async pair(
    name: string,
    passwordKey: string,
    now: number,
  ): Promise<{ token: string; device: Device }> {
    const stored = await this.#load();
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = {
      id: randomUUID(),
      name,
      pairedAt: now,
      lastSeen: null,
      token: hash(token),
      password: hash(passwordKey),
    };
    await this.#save({ ...stored, devices: [...stored.devices, device] });
    log.info("a device was paired", { device: device.id, name });
    return { token, device: { id: device.id, name, pairedAt: now, lastSeen: null } };
  }

  /**
   * The device `token` belongs to, if it was paired under the password the
   * library has now. A token from before a password change is refused: the
   * password is what let it in (ADR-0072 §3.5).
   */
  async verify(token: string, passwordKey: string, now: number): Promise<Device | undefined> {
    const stored = await this.#load();
    const want = Buffer.from(hash(token), "hex");
    const password = hash(passwordKey);
    const found = stored.devices.find((device) => {
      const have = Buffer.from(device.token, "hex");
      return have.length === want.length && timingSafeEqual(have, want);
    });
    if (found === undefined || found.password !== password) return undefined;

    if (found.lastSeen === null || now - found.lastSeen >= SEEN_EVERY) {
      const seen = { ...found, lastSeen: now };
      void this.#save({
        ...stored,
        devices: stored.devices.map((device) => (device.id === found.id ? seen : device)),
      }).catch((error: unknown) =>
        log.warn("a device's last-seen time could not be written", {
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
    return { id: found.id, name: found.name, pairedAt: found.pairedAt, lastSeen: now };
  }

  /** Answers whether there was such a device. */
  async revoke(id: string): Promise<boolean> {
    const stored = await this.#load();
    const left = stored.devices.filter((device) => device.id !== id);
    if (left.length === stored.devices.length) return false;
    await this.#save({ ...stored, devices: left });
    log.info("a device was unpaired", { device: id });
    return true;
  }

  /** Waits for the writes already started, for a caller about to stop. */
  settled(): Promise<void> {
    return this.#writing.catch(() => undefined);
  }
}

function parseStored(value: unknown): Stored {
  if (typeof value !== "object" || value === null) return EMPTY;
  const sharing = Reflect.get(value, "sharing") === true;
  const raw = Reflect.get(value, "devices");
  const devices: StoredDevice[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = Reflect.get(entry, "id");
      const name = Reflect.get(entry, "name");
      const pairedAt = Reflect.get(entry, "pairedAt");
      const lastSeen = Reflect.get(entry, "lastSeen");
      const token = Reflect.get(entry, "token");
      const password = Reflect.get(entry, "password");
      if (
        typeof id === "string" &&
        typeof name === "string" &&
        typeof pairedAt === "number" &&
        (lastSeen === null || typeof lastSeen === "number") &&
        typeof token === "string" &&
        /^[0-9a-f]{64}$/.test(token) &&
        typeof password === "string"
      ) {
        devices.push({ id, name, pairedAt, lastSeen, token, password });
      }
    }
  }
  return { sharing, devices };
}
