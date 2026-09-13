/**
 * `@roost/media` is everything that touches file bytes: magic-byte format
 * probing, decode and downscale to the two thumbnail sizes the specification
 * names, metadata extraction, and streamed BLAKE3 content hashing. Perceptual
 * hashes and dominant colour belong here too, and arrive with M5.
 *
 * Optional backends are runtime-probed, never hard dependencies: an asset whose
 * decoder is missing still imports, with no thumbnail rather than an error.
 */
export {
  CAPABILITIES,
  CAPABILITY_FORMATS,
  type Capability,
  type CapabilityName,
  capabilities,
  capability,
  capabilityFor,
  isCapabilityName,
  refreshCapabilities,
} from "./capability.js";
export {
  type DecoderBuild,
  decoderVersions,
  isRenderable,
  type PixelSource,
  renderThumbnails,
  type Thumbnail,
  WEBP_QUALITY,
} from "./decoder.js";
export { type Derived, type DeriveOutcome, derive } from "./derive.js";
export {
  documentVersion,
  PAGE_RENDER_WIDTH,
  pageCount,
  type RenderedPage,
  renderPage,
} from "./document.js";
export { ExternalToolError } from "./external.js";
export {
  type FontFacts,
  readFont,
  renderSpecimen,
  SPECIMEN_TEXT,
} from "./font.js";
export {
  FORMATS,
  type Format,
  formatFromExtension,
  isBrowserDrawable,
  isFormat,
  kindOf,
  mediaTypeOf,
  SNIFF_BYTES,
  sniff,
} from "./format.js";
export {
  FULL_HASH_MAX_BYTES,
  type Hashed,
  hashBytes,
  hashFile,
  PARTIAL_WINDOW_BYTES,
} from "./hash.js";
export {
  type Installable,
  type InstallOffer,
  installCommand,
  installOffer,
} from "./install.js";
export { adoptUserPath, type InstallOutcome, installBackend } from "./installer.js";
export { type Probed, probe, sniffFile } from "./probe.js";
export {
  type EmbeddedPreview,
  isTiffContainer,
  looksLikeRaw,
  parseRaw,
  type RawFacts,
  readRaw,
} from "./raw.js";
export { type Rendition, renderForBrowser } from "./render.js";
export { isConvertible, SUBTITLE_EXTENSIONS, toWebVtt } from "./subtitle.js";
export {
  gradient,
  gradientPixels,
  isSyntheticFormat,
  SYNTHETIC_FORMATS,
  type SyntheticFormat,
  syntheticFormatForExtension,
} from "./synth.js";
export {
  EAGER_SIZES,
  GRID_SIZE,
  generateThumbnails,
  PREVIEW_SIZE,
  THUMBNAIL_SIZES,
} from "./thumbnail.js";
export {
  type Raster,
  rasteriseSvg,
  rasteriseSvgFile,
  VECTOR_RENDER_WIDTH,
  vectorVersion,
} from "./vector.js";
export { drawWaveform, type Pixels } from "./waveform.js";
