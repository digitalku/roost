import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { EmptyPasswordError } from "./error.js";

/**
 * A library's password, as `library.json` carries it (RL-5c, ADR-0071).
 *
 * It gates the library and encrypts nothing. The hash is readable by anybody
 * who can read the folder, which is why the cost parameters are what they are:
 * the hash is the one thing here a guesser can work on without asking.
 */
export interface PasswordRecord {
  readonly kdf: "scrypt";
  readonly n: number;
  readonly r: number;
  readonly p: number;
  /** Lowercase hex. */
  readonly salt: string;
  /** Lowercase hex, 32 bytes. */
  readonly hash: string;
}

/**
 * What a new password is hashed with.
 *
 * OWASP's first scrypt setting: 128 MiB and roughly a fifth of a second, which
 * is nothing once per open and a great deal per guess. Stored with the hash, so
 * raising it later breaks no library that already has a password.
 */
const DEFAULT_COST = { n: 2 ** 17, r: 8, p: 1 } as const;

const HASH_BYTES = 32;
const SALT_BYTES = 16;

/** RL-5c's ceiling on what a check may cost in memory. */
const MEMORY_CEILING = 256 * 1024 * 1024;

const HEX = /^[0-9a-f]*$/;

/**
 * Reads the `password` field, or says why it is not one (RL-5c).
 *
 * Returns the reason rather than throwing, because the caller is the manifest
 * reader and it alone knows how to say "not a library" for this folder.
 */
export function parsePasswordRecord(value: unknown): PasswordRecord | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "password is not an object";
  }
  const kdf = Reflect.get(value, "kdf");
  const n = Reflect.get(value, "n");
  const r = Reflect.get(value, "r");
  const p = Reflect.get(value, "p");
  const salt = Reflect.get(value, "salt");
  const hash = Reflect.get(value, "hash");

  if (kdf !== "scrypt") return "password.kdf is not scrypt";
  if (!isIntegerIn(n, 2 ** 14, 2 ** 20) || !isPowerOfTwo(n)) {
    return "password.n is not a power of two from 2^14 to 2^20";
  }
  if (!isIntegerIn(r, 1, 32)) return "password.r is not an integer from 1 to 32";
  if (!isIntegerIn(p, 1, 16)) return "password.p is not an integer from 1 to 16";
  if (128 * n * r > MEMORY_CEILING) return "password.n × password.r needs more than 256 MiB";
  if (
    typeof salt !== "string" ||
    salt.length < SALT_BYTES * 2 ||
    salt.length > 128 ||
    salt.length % 2 !== 0 ||
    !HEX.test(salt)
  ) {
    return "password.salt is not 32 to 128 lowercase hex characters";
  }
  if (typeof hash !== "string" || hash.length !== HASH_BYTES * 2 || !HEX.test(hash)) {
    return "password.hash is not 64 lowercase hex characters";
  }
  return { kdf, n, r, p, salt, hash };
}

/** A new record for `password`, with a fresh salt. */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  if (password.length === 0) throw new EmptyPasswordError();
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const cost = DEFAULT_COST;
  const hash = await derive(password, salt, cost);
  return { kdf: "scrypt", ...cost, salt, hash: hash.toString("hex") };
}

/** Whether `password` is the one `record` was made from. */
export async function passwordMatches(record: PasswordRecord, password: string): Promise<boolean> {
  const expected = Buffer.from(record.hash, "hex");
  const actual = await derive(password, record.salt, record);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function derive(
  password: string,
  salt: string,
  cost: { readonly n: number; readonly r: number; readonly p: number },
): Promise<Buffer> {
  // NFC, so that the same password typed on two keyboards is the same bytes
  // (RL-5c). The asynchronous scrypt runs on libuv's pool, so a check does not
  // stall the engine's thread for the fifth of a second it takes.
  const bytes = Buffer.from(password.normalize("NFC"), "utf8");
  return new Promise((resolve, reject) => {
    scrypt(
      bytes,
      Buffer.from(salt, "hex"),
      HASH_BYTES,
      { N: cost.n, r: cost.r, p: cost.p, maxmem: MEMORY_CEILING + 1024 * 1024 },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    );
  });
}

/**
 * Proof that a library's password was given, held in place of the password.
 *
 * A rename closes the library and opens it again (ADR-0056), and asking the
 * person a second time would be absurd, but keeping what they typed in the
 * engine's memory for the life of the library would be worse. Only this module
 * can make one, because only this module holds the table that says which hash
 * it was checked against — so an unlock is worthless once the password changes,
 * and cannot be built by anything that merely read `library.json`.
 */
export interface Unlock {
  readonly __unlock: never;
}

const unlocks = new WeakMap<Unlock, string>();

export function issueUnlock(record: PasswordRecord): Unlock {
  // The cast is the brand: an empty frozen object, given its meaning only by
  // the table entry made beside it.
  const unlock = Object.freeze({}) as Unlock;
  unlocks.set(unlock, record.hash);
  return unlock;
}

export function unlockMatches(unlock: Unlock, record: PasswordRecord): boolean {
  return unlocks.get(unlock) === record.hash;
}

function isIntegerIn(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

function isPowerOfTwo(value: number): boolean {
  return (value & (value - 1)) === 0;
}
