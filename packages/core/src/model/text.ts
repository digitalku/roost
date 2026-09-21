/**
 * Text that is about to be written down.
 *
 * One function, and it exists because two operating systems disagree about how
 * to spell the same filename.
 */

/**
 * Unicode NFC, as RL-36 requires of every filename that reaches the journal.
 *
 * `café möbel.png` has two encodings: `caf` `U+00E9`, and `cafe` followed by a
 * combining acute. They look identical, they are different bytes, and which one
 * arrives depends on where the name was typed — macOS hands out decomposed
 * names, Windows and Linux hand out whatever was stored. Nothing downstream can
 * recover from the difference: two spellings of one name are two assets to a
 * search, two rows to a comparison, and two different answers when two
 * implementations look at one library.
 *
 * **Normalising at the write path is the whole requirement.** Doing it on read
 * instead would leave the journal — the durable thing, the thing another
 * implementation reads — holding whichever form the machine happened to
 * produce.
 *
 * Composition never changes what a name *means*, so this is safe to apply to
 * anything a person will see. It is not applied to files under `files/`,
 * which are named by hash and contain no letters at all.
 */
export function toNfc(text: string): string {
  return text.normalize("NFC");
}
