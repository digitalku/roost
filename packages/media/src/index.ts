/**
 * `@roost/media` is everything that touches file bytes: magic-byte format
 * probing, decode and downscale to the two thumbnail sizes the specification
 * names, metadata extraction, and streamed BLAKE3 content hashing. Perceptual
 * hashes and dominant colour belong here too, and arrive with M5.
 *
 * Optional backends are runtime-probed, never hard dependencies: an asset whose
 * decoder is missing still imports, with a placeholder and a note.
 *
 * Arrives with M1.
 */
export {};
