/**
 * Who made this and where to reach them (ADR-0038 §5).
 *
 * One module because two places draw it — the About dialog and the picker's
 * footer — and a copyright notice that disagrees with itself is worse than one
 * that is only in a file nobody opens.
 *
 * These are constants rather than something the engine answers, unlike the
 * version beside them: they are the same in every build, and asking a process
 * for a string that cannot vary is a round trip that can fail.
 */

export const PRODUCT = "Roost";

/** The holder, as the licence names them. */
export const COPYRIGHT = "© 2026 Digitalku";

/** Shown without a scheme and opened with one — nobody reads `https://` aloud. */
export const HOMEPAGE = "roost.digitalku.com";
export const HOMEPAGE_URL = "https://roost.digitalku.com";

/**
 * Drawn as text, never as a `mailto:` link.
 *
 * `link:open` refuses anything but `http(s)` (ADR-0030 §5), and that refusal is
 * a security rule about handing schemes to the desktop rather than an oversight
 * to route around for our own address. An address that can be read and copied
 * is what an email client needs anyway.
 */
export const SUPPORT_EMAIL = "roostsupport@digitalku.com";

/** One sentence, the same one the README opens with. */
export const TAGLINE = "A local-first digital asset manager.";
