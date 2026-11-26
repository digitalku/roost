import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Whether `address` is one a phone at home could have (ADR-0072 §3.7).
 *
 * The listener is on every interface so that a phone can reach it, and this is
 * what keeps it on the local network anyway: loopback, the private ranges,
 * link-local, IPv6 unique-local and link-local, and `100.64/10`, which is where
 * Tailscale numbers its devices. An address on the internet is never answered,
 * so a router forwarding the port by mistake exposes nothing.
 */
export function isLocalAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  // A dual-stack socket reports an IPv4 peer as `::ffff:a.b.c.d`.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped?.[1] ?? address;

  if (isIPv4(plain)) {
    const [a = -1, b = -1] = plain.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIPv6(plain)) {
    const lower = plain.toLowerCase();
    if (lower === "::1") return true;
    const first = Number.parseInt(lower.split(":")[0] ?? "", 16);
    if (Number.isNaN(first)) return false;
    // fc00::/7 is unique-local, fe80::/10 link-local; Tailscale's own IPv6
    // range, fd7a:115c:a1e0::/48, falls inside the first.
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * What to type into the phone: one URL per address this machine has on a
 * local network, IPv4 first because that is what a person reads aloud.
 *
 * Link-local addresses are left out. They are answered, but nobody types one,
 * and an IPv6 one needs an interface name the phone does not have.
 */
export function addressesToType(port: number): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || !isLocalAddress(entry.address)) continue;
      if (entry.address.startsWith("169.254.") || entry.address.toLowerCase().startsWith("fe80")) {
        continue;
      }
      found.push(
        entry.family === "IPv6"
          ? `http://[${entry.address}]:${port}`
          : `http://${entry.address}:${port}`,
      );
    }
  }
  return found.sort((a, b) => Number(a.includes("[")) - Number(b.includes("[")));
}
