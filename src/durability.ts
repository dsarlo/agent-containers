import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export type DurabilityTarget = 'file' | 'directory';
export type DurabilityMethod = 'fsync' | 'fullfsync' | 'flush-file-buffers' | 'move-file-write-through' | 'unsupported';
/** Strict publication has directory persistence; recoverable publication has an old-valid-or-new-valid journal. */
export type StatePublicationMode = 'strict' | 'recoverable';

export interface NativeDurabilityCapabilities {
  regularFileSync: boolean;
  directorySync: boolean;
  writeThroughMove: boolean;
}

export interface NativePathDurabilityResult {
  ok: boolean;
  path: string;
  target: DurabilityTarget;
  method: DurabilityMethod;
  error?: string;
}

export interface NativeMoveDurabilityResult {
  ok: boolean;
  source: string;
  destination: string;
  method: 'move-file-write-through' | 'unsupported';
  /** Stable filesystem error code when the native move did not publish. */
  code?: 'EEXIST' | 'ENOTEMPTY';
  /** Windows error identifier emitted by the native MoveFileExW bridge. */
  windowsError?: 'ERROR_ACCESS_DENIED';
  error?: string;
}

export interface NativeDurabilityBinding {
  capabilities(): NativeDurabilityCapabilities | Promise<NativeDurabilityCapabilities>;
  syncPath(path: string): NativePathDurabilityResult | Promise<NativePathDurabilityResult>;
  moveFileWriteThrough(source: string, destination: string): NativeMoveDurabilityResult | Promise<NativeMoveDurabilityResult>;
}

interface NativeWindowsDirectoryBinding {
  windowsDirectory(): string | undefined;
}

/** Boundary used by state writers; production resolves it from the packaged N-API addon. */
export interface StateDurabilityAdapter {
  /** Directory-persistent POSIX publication or Windows write-through recoverable publication. */
  publicationMode(): Promise<StatePublicationMode>;
  /** Reject before any state-directory or lifecycle side effect when the required guarantees are absent. */
  assertStateWriteSupport(): Promise<void>;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  /** Windows MoveFileExW(MOVEFILE_WRITE_THROUGH); intentionally exposed for a later publication protocol. */
  moveFileWriteThrough(source: string, destination: string): Promise<void>;
}

export function createNativeDurabilityAdapter(binding: NativeDurabilityBinding): StateDurabilityAdapter {
  return {
    async publicationMode(): Promise<StatePublicationMode> {
      return publicationMode(await binding.capabilities());
    },
    async assertStateWriteSupport(): Promise<void> {
      const capabilities = await binding.capabilities();
      const missing = !capabilities.regularFileSync
        ? ['regular-file durability']
        : capabilities.directorySync || capabilities.writeThroughMove
          ? []
          : ['directory durability or Windows write-through publication'];
      if (missing.length > 0) throw new Error(`Native durability support is unavailable for ${missing.join(' and ')}; refusing state writes before lifecycle work.`);
    },
    async syncFile(path: string): Promise<void> {
      await assertPathResult(binding, path, 'file');
    },
    async syncDirectory(path: string): Promise<void> {
      const capabilities = await binding.capabilities();
      // Windows has no equivalent per-directory flush. This is deliberately a
      // no-op only in the explicitly recoverable publication protocol.
      if (capabilities.regularFileSync && !capabilities.directorySync && capabilities.writeThroughMove) return;
      await assertPathResult(binding, path, 'directory');
    },
    async moveFileWriteThrough(source: string, destination: string): Promise<void> {
      const result = await binding.moveFileWriteThrough(source, destination);
      if (!result.ok) {
        const error = new Error(result.error ?? `Native write-through move failed for ${source} -> ${destination}.`);
        const code = result.windowsError === 'ERROR_ACCESS_DENIED' ? 'EPERM' : result.code;
        if (code) Object.assign(error, { code });
        throw error;
      }
    },
  };
}

function publicationMode(capabilities: NativeDurabilityCapabilities): StatePublicationMode {
  if (capabilities.regularFileSync && capabilities.directorySync) return 'strict';
  if (capabilities.regularFileSync && capabilities.writeThroughMove) return 'recoverable';
  throw new Error('Native durability support is unavailable for regular-file durability and a supported publication protocol; refusing state writes before lifecycle work.');
}

async function assertPathResult(binding: NativeDurabilityBinding, path: string, expectedTarget: DurabilityTarget): Promise<void> {
  const result = await binding.syncPath(path);
  if (!result.ok) throw new Error(result.error ?? `Native ${expectedTarget} durability sync failed for ${path}.`);
  if (result.target !== expectedTarget) throw new Error(`Native durability sync expected a ${expectedTarget} at ${path}, but found a ${result.target}.`);
}

let productionAdapter: StateDurabilityAdapter | undefined;

/** Resolve the package root from a compiled source file under dist/src. */
export function nativeAddonPackageRoot(moduleUrl: string = import.meta.url): string {
  return resolve(fileURLToPath(new URL('../../', moduleUrl)));
}

/** Lazily load the packaged addon; absence is represented by an adapter that fails closed. */
export function getProductionStateDurabilityAdapter(): StateDurabilityAdapter {
  productionAdapter ??= loadProductionAdapter();
  return productionAdapter;
}

/** Return the Windows directory only when the packaged native bridge obtained it from the OS. */
export function getAuthoritativeWindowsDirectory(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const require = createRequire(import.meta.url);
    const load = require('node-gyp-build') as (directory: string) => unknown;
    const candidate = load(nativeAddonPackageRoot());
    if (!isNativeWindowsDirectoryBinding(candidate)) return undefined;
    const directory = candidate.windowsDirectory();
    return typeof directory === 'string' && win32.isAbsolute(directory) ? directory : undefined;
  } catch {
    return undefined;
  }
}

function loadProductionAdapter(): StateDurabilityAdapter {
  try {
    const require = createRequire(import.meta.url);
    const load = require('node-gyp-build') as (directory: string) => unknown;
    const candidate = load(nativeAddonPackageRoot());
    if (!isNativeDurabilityBinding(candidate)) throw new Error('The native addon does not export the required durability API.');
    return createNativeDurabilityAdapter(candidate);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return unavailableAdapter(`Native durability addon could not be loaded: ${detail}`);
  }
}

function unavailableAdapter(message: string): StateDurabilityAdapter {
  const unavailable = async (): Promise<never> => { throw new Error(message); };
  return {
    publicationMode: unavailable,
    assertStateWriteSupport: unavailable,
    syncFile: unavailable,
    syncDirectory: unavailable,
    moveFileWriteThrough: unavailable,
  };
}

function isNativeDurabilityBinding(value: unknown): value is NativeDurabilityBinding {
  return typeof value === 'object' && value !== null &&
    'capabilities' in value && typeof value.capabilities === 'function' &&
    'syncPath' in value && typeof value.syncPath === 'function' &&
    'moveFileWriteThrough' in value && typeof value.moveFileWriteThrough === 'function';
}

function isNativeWindowsDirectoryBinding(value: unknown): value is NativeWindowsDirectoryBinding {
  return typeof value === 'object' && value !== null &&
    'windowsDirectory' in value && typeof value.windowsDirectory === 'function';
}
