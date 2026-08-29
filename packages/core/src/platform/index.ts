export { REFLINK_SUPPORT, type ReflinkSupport, reflinkSupported } from "./caps.js";
export { APP_NAME, cacheDir, configDir, dataDir, lockDir, logDir, stateDir } from "./dirs.js";
export {
  acquireLock,
  acquireLockAt,
  type InstanceLock,
  type LockOutcome,
  lockPathFor,
} from "./lock.js";
export { openExternally, revealInFileManager } from "./reveal.js";
export { DEFAULT_THREAD_POOL, threadPoolEnv, threadPoolSize } from "./threadpool.js";
