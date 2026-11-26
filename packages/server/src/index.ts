/**
 * `@roost/server` shares a library on the local network, for a phone
 * (ADR-0072). It is the transport and nothing else: the routes `REMOTE.md`
 * describes, pairing, the devices, and the address filter. Main gives it the
 * same doors a window has, so a phone gets the window's answers.
 */
export { addressesToType, isLocalAddress } from "./addresses.js";
export { REMOTE_EVENTS, REMOTE_REQUESTS } from "./allowed.js";
export { type Device, DeviceStore } from "./devices.js";
export {
  DEFAULT_REMOTE_PORT,
  LibrarySharing,
  REMOTE_API_VERSION,
  type SharedLibrary,
  type SharingHost,
  type SharingOptions,
  type SharingStatus,
} from "./sharing.js";
