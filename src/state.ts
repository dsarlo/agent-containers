import { lstat, mkdir, open, readdir, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidWorkspaceName, validateWorkspaceName } from './names.js';

export interface WorkspaceMetadata {
  version: 1;
  name: string;
  repoRoot: string;
  worktree: string;
  branch: string;
  /** Verified local branch ref used as the immutable cleanup base. */
  baseRef: string;
  devcontainerPath: string;
  createdAt: string;
  containerId?: string;
  cleanup?: {
    container?: boolean;
    worktree?: boolean;
    branch?: boolean;
  };
}

export interface StaleLockRecoveryHooks {
  /** Test seam: runs after ownership is validated while normal acquisition remains blocked. */
  beforeRemoval?: () => void | Promise<void>;
}

interface LockOwner {
  pid: number;
  token: string;
  createdAt?: string;
}

export interface ManualRecovery {
  version: 1;
  reason: 'operation-may-be-active' | 'remote-exec-interrupted' | 'devcontainer-up-ambiguous';
  containerIds: string[];
  worktree: string;
  createdAt: string;
}

export interface ManualRecoveryInput {
  reason: ManualRecovery['reason'];
  containerIds: string[];
  worktree: string;
}

export function defaultStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-containers');
}

export function metadataPath(stateDir: string, name: string): string {
  return join(stateDir, 'workspaces', `${validateWorkspaceName(name)}.json`);
}

function manualRecoveryPath(stateDir: string, name: string): string {
  return join(stateDir, 'locks', `${validateWorkspaceName(name)}.manual-recovery.json`);
}

/** Persist a recovery barrier before a lifecycle can release after remote completion is unknown. */
export async function recordManualRecovery(stateDir: string, name: string, input: ManualRecoveryInput): Promise<void> {
  const recovery: ManualRecovery = { version: 1, ...input, createdAt: new Date().toISOString() };
  if (!isManualRecovery(recovery)) throw new Error('Refusing to save invalid manual recovery state.');
  const path = manualRecoveryPath(stateDir, name);
  const directory = join(stateDir, 'locks');
  await ensureDurableDirectory(directory);
  const temporaryPath = join(directory, `.${validateWorkspaceName(name)}.${randomUUID()}.manual-recovery.tmp`);
  await durableReplace(temporaryPath, path, directory, `${JSON.stringify(recovery, null, 2)}\n`);
}

async function durableReplace(temporaryPath: string, path: string, directory: string, content: string): Promise<void> {
  let file: FileHandle | undefined;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await file?.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function loadManualRecovery(stateDir: string, name: string): Promise<ManualRecovery | undefined> {
  try {
    const recovery: unknown = JSON.parse(await readFile(manualRecoveryPath(stateDir, name), 'utf8'));
    if (!isManualRecovery(recovery)) throw new Error(`Manual recovery state for ${name} is invalid; refusing to release lifecycle protection.`);
    return recovery;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** This is deliberately separate from `unlock`: it records an operator's explicit remote-state acknowledgement. */
export async function clearManualRecovery(stateDir: string, name: string): Promise<void> {
  const recovery = await loadManualRecovery(stateDir, name);
  if (!recovery) throw new Error(`No manual recovery block exists for workspace "${name}".`);
  await durableRemove(manualRecoveryPath(stateDir, name), join(stateDir, 'locks'), false);
}

export async function loadMetadata(stateDir: string, name: string): Promise<WorkspaceMetadata | undefined> {
  try {
    const metadata: unknown = JSON.parse(await readFile(metadataPath(stateDir, name), 'utf8'));
    if (typeof metadata === 'object' && metadata !== null && 'name' in metadata && metadata.name !== name) {
      throw new Error(`Metadata filename ${name} does not match metadata.name.`);
    }
    if (!isAgentContainersWorkspace(metadata)) throw new Error(`Metadata for ${name} is not a valid Agent Containers workspace.`);
    return metadata;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveMetadata(stateDir: string, metadata: WorkspaceMetadata): Promise<void> {
  if (!isAgentContainersWorkspace(metadata)) throw new Error('Refusing to save invalid Agent Containers workspace metadata.');
  const path = metadataPath(stateDir, metadata.name);
  const directory = join(stateDir, 'workspaces');
  await ensureDurableDirectory(directory);
  const temporaryPath = join(directory, `.${metadata.name}.${randomUUID()}.tmp`);
  await durableReplace(temporaryPath, path, directory, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function deleteMetadata(stateDir: string, name: string): Promise<void> {
  await durableRemove(metadataPath(stateDir, name), join(stateDir, 'workspaces'), true);
}

export async function listMetadata(stateDir: string): Promise<WorkspaceMetadata[]> {
  try {
    const files = await readdir(join(stateDir, 'workspaces'));
    const entries = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => loadMetadata(stateDir, file.slice(0, -5))));
    return entries.filter((entry): entry is WorkspaceMetadata => entry !== undefined);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function isAgentContainersWorkspace(metadata: unknown): metadata is WorkspaceMetadata {
  return typeof metadata === 'object' && metadata !== null &&
    'version' in metadata && metadata.version === 1 &&
    'name' in metadata && typeof metadata.name === 'string' && isValidWorkspaceName(metadata.name) &&
    'branch' in metadata && metadata.branch === `agent-containers/${metadata.name}` &&
    'worktree' in metadata && isCanonicalPath(metadata.worktree) &&
    'repoRoot' in metadata && isCanonicalPath(metadata.repoRoot) &&
    'baseRef' in metadata && isLocalBranchRef(metadata.baseRef) &&
    'devcontainerPath' in metadata && typeof metadata.devcontainerPath === 'string' &&
    'createdAt' in metadata && typeof metadata.createdAt === 'string' &&
    (!('containerId' in metadata) || metadata.containerId === undefined || (typeof metadata.containerId === 'string' && metadata.containerId.length > 0)) &&
    (!('cleanup' in metadata) || metadata.cleanup === undefined || isCleanupState(metadata.cleanup));
}

function isCanonicalPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
}

function isLocalBranchRef(value: unknown): value is string {
  return typeof value === 'string' && /^refs\/heads\/.+/.test(value) &&
    !/[\s~^:?*\\[]/.test(value) && ![...value].some((character) => character.charCodeAt(0) <= 0x1f) &&
    !value.endsWith('.') && !value.endsWith('/');
}

function isCleanupState(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.entries(value).every(([key, completed]) =>
    ['container', 'worktree', 'branch'].includes(key) && typeof completed === 'boolean');
}

function isManualRecovery(value: unknown): value is ManualRecovery {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<ManualRecovery> : undefined;
  return candidate?.version === 1 &&
    (candidate.reason === 'operation-may-be-active' || candidate.reason === 'remote-exec-interrupted' || candidate.reason === 'devcontainer-up-ambiguous') &&
    Array.isArray(candidate.containerIds) && candidate.containerIds.every((id) => typeof id === 'string' && id.length > 0) &&
    isCanonicalPath(candidate.worktree) && typeof candidate.createdAt === 'string';
}

function manualRecoveryError(name: string): Error {
  return new Error(`Workspace "${name}" is blocked by durable manual recovery because a remote Dev Container operation may still be active. Verify the remote command/container state, then run agent-containers recover ${name} --yes --remote-command-stopped. The ordinary unlock command never clears this block.`);
}

export interface WorkspaceLockOptions {
  timeoutMs?: number;
  /** Optional test or embedding cancellation source; process signals are wired internally. */
  abortSignal?: AbortSignal;
  /** Allows only the recovery acknowledgement to acquire a guarded lifecycle lock. */
  allowManualRecovery?: boolean;
  /** Test seam called after each completed crash-durability publication boundary. */
  onLockPublication?: (step: LockPublicationStep) => void | Promise<void>;
  /** Test seam for progressively durable state-directory creation. */
  onStateDirectoryDurability?: (step: StateDirectoryDurabilityStep) => void | Promise<void>;
}

export type LockPublicationStep = 'owner-file-synced' | 'staging-directory-synced' | 'published' | 'locks-directory-synced';
export interface StateDirectoryDurabilityStep {
  kind: 'created' | 'directory-synced' | 'parent-directory-synced';
  path: string;
}

export async function withWorkspaceLock<T>(stateDir: string, name: string, action: (signal: AbortSignal) => Promise<T>, options: number | WorkspaceLockOptions = 30_000): Promise<T> {
  const { timeoutMs, abortSignal, allowManualRecovery, onLockPublication, onStateDirectoryDurability } = typeof options === 'number'
    ? { timeoutMs: options, abortSignal: undefined, allowManualRecovery: false, onLockPublication: undefined, onStateDirectoryDurability: undefined }
    : { timeoutMs: options.timeoutMs ?? 30_000, abortSignal: options.abortSignal, allowManualRecovery: options.allowManualRecovery ?? false, onLockPublication: options.onLockPublication, onStateDirectoryDurability: options.onStateDirectoryDurability };
  const lockName = validateWorkspaceName(name);
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, `${lockName}.lock`);
  const recoveryPath = join(locksDir, `${lockName}.recovery`);
  await ensureDurableDirectory(locksDir, onStateDirectoryDurability);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await waitForRecoveryToFinish(recoveryPath, deadline, name);
    if (await acquireOwnedDirectory(lockPath, locksDir, lockName, deadline, name, onLockPublication)) break;
  }
  try {
    if (!allowManualRecovery && await loadManualRecovery(stateDir, lockName)) throw manualRecoveryError(name);
  } catch (error) {
    await durableRemove(lockPath, locksDir, true);
    throw error;
  }
  const cancellation = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const cancel = () => cancellation.abort();
  const onSignal = (signal: NodeJS.Signals) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    cancel();
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  abortSignal?.addEventListener('abort', cancel, { once: true });
  if (abortSignal?.aborted) cancel();
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    if (cancellation.signal.aborted) throw abortError();
    return await action(cancellation.signal);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    abortSignal?.removeEventListener('abort', cancel);
    await durableRemove(lockPath, locksDir, true);
    if (receivedSignal) process.kill(process.pid, receivedSignal);
  }
}

/** Release only a lock whose recorded local owner PID is proven no longer alive. */
export async function releaseStaleWorkspaceLock(stateDir: string, name: string, isPidAlive: (pid: number) => boolean = localPidIsAlive, hooks: StaleLockRecoveryHooks = {}, timeoutMs = 30_000): Promise<void> {
  const lockName = validateWorkspaceName(name);
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, `${lockName}.lock`);
  const recoveryPath = join(locksDir, `${lockName}.recovery`);
  await ensureDurableDirectory(locksDir);
  if (await loadManualRecovery(stateDir, lockName)) throw manualRecoveryError(name);
  await acquireRecoveryLock(recoveryPath, locksDir, lockName, Date.now() + timeoutMs, name, isPidAlive);
  try {
    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) throw new Error(`No recoverable lifecycle lock exists for workspace "${name}". Refusing to remove a lock without owner metadata.`, { cause: error });
      throw malformedLockError(name, lockPath, error);
    }
    if (!isLockOwner(owner)) {
      throw malformedLockError(name, lockPath);
    }
    if (isPidAlive(owner.pid)) throw new Error(`Lifecycle lock for workspace "${name}" is owned by active PID ${owner.pid}; refusing to interrupt it.`);
    await hooks.beforeRemoval?.();
    const reclaimedPath = join(locksDir, `.${lockName}.${owner.token}.reclaimed`);
    await durableRename(lockPath, reclaimedPath, locksDir);
    await durableRemove(reclaimedPath, locksDir, false);
  } finally {
    await durableRemove(recoveryPath, locksDir, true);
  }
}

async function waitForRecoveryToFinish(recoveryPath: string, deadline: number, name: string): Promise<void> {
  while (true) {
    try {
      await lstat(recoveryPath);
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    const owner = await readLockOwner(recoveryPath);
    if (owner && !localPidIsAlive(owner.pid)) {
      const abandonedPath = `${recoveryPath}.${owner.token}.abandoned`;
      try {
        await durableRename(recoveryPath, abandonedPath, dirname(recoveryPath));
        await durableRemove(abandonedPath, dirname(recoveryPath), false);
        return;
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        continue;
      }
    }
    if (Date.now() >= deadline) throw lockTimeout(name);
    await delay();
  }
}

async function acquireRecoveryLock(recoveryPath: string, locksDir: string, lockName: string, deadline: number, name: string, isPidAlive: (pid: number) => boolean): Promise<void> {
  while (true) {
    await reclaimDeadPublishedLock(recoveryPath, isPidAlive);
    if (await acquireOwnedDirectory(recoveryPath, locksDir, `${lockName}.recovery`, deadline, name)) return;
  }
}

async function reclaimDeadPublishedLock(path: string, isPidAlive: (pid: number) => boolean): Promise<void> {
  const owner = await readLockOwner(path);
  if (!owner || isPidAlive(owner.pid)) return;
  const abandonedPath = `${path}.${owner.token}.abandoned`;
  try {
    await durableRename(path, abandonedPath, dirname(path));
    await durableRemove(abandonedPath, dirname(path), false);
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

/** Build owner metadata off-path, then atomically publish the directory. */
async function acquireOwnedDirectory(path: string, locksDir: string, temporaryStem: string, deadline: number, name: string, onLockPublication?: (step: LockPublicationStep) => void | Promise<void>): Promise<boolean> {
  const temporaryPath = join(locksDir, `.${temporaryStem}.${randomUUID()}.pending`);
  let ownerFile: FileHandle | undefined;
  try {
    await mkdir(temporaryPath, { recursive: false, mode: 0o700 });
    const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    ownerFile = await open(join(temporaryPath, 'owner.json'), 'wx', 0o600);
    await ownerFile.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await ownerFile.sync();
    await ownerFile.close();
    ownerFile = undefined;
    await onLockPublication?.('owner-file-synced');
    await syncDirectory(temporaryPath);
    await onLockPublication?.('staging-directory-synced');
    await rename(temporaryPath, path);
    await onLockPublication?.('published');
    await syncDirectory(locksDir);
    await onLockPublication?.('locks-directory-synced');
    return true;
  } catch (error: unknown) {
    await ownerFile?.close();
    await rm(temporaryPath, { recursive: true, force: true });
    if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
    if (Date.now() >= deadline) throw lockTimeout(name, error);
    await delay();
    return false;
  }
}

async function ensureDurableDirectory(directory: string, onDurabilityStep?: (step: StateDirectoryDurabilityStep) => void | Promise<void>): Promise<void> {
  assertDirectoryFsyncSupported();
  const missing: string[] = [];
  let current = resolve(directory);
  while (true) {
    let entry;
    try {
      entry = await lstat(current);
    } catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Unable to find an existing parent for state directory: ${directory}`, { cause: error });
      missing.push(current);
      current = parent;
      continue;
    }
    if (!entry.isDirectory()) throw new Error(`State directory path is not a directory: ${current}`);
    break;
  }
  for (const createdDirectory of missing.reverse()) {
    const parent = dirname(createdDirectory);
    let created = false;
    try {
      await mkdir(createdDirectory, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error: unknown) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const entry = await lstat(createdDirectory);
      if (!entry.isDirectory()) throw new Error(`State directory path is not a directory: ${createdDirectory}`, { cause: error });
    }
    if (created) await onDurabilityStep?.({ kind: 'created', path: createdDirectory });
    await syncDirectory(createdDirectory);
    await onDurabilityStep?.({ kind: 'directory-synced', path: createdDirectory });
    await syncDirectory(parent);
    await onDurabilityStep?.({ kind: 'parent-directory-synced', path: parent });
  }
}

function assertDirectoryFsyncSupported(): void {
  if (process.platform === 'win32') {
    throw new Error('Agent Containers cannot safely create durable state directories on Windows because directory fsync is unavailable.');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableRename(source: string, destination: string, directory: string): Promise<void> {
  await rename(source, destination);
  await syncDirectory(directory);
}

async function durableRemove(path: string, directory: string, force: boolean): Promise<void> {
  await rm(path, { recursive: true, force });
  await syncDirectory(directory);
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const owner: unknown = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    return isLockOwner(owner) ? owner : undefined;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function abortError(): Error {
  const error = new Error('Lifecycle action was aborted.');
  error.name = 'AbortError';
  return error;
}

function lockTimeout(name: string, cause?: unknown): Error {
  return new Error(`Timed out waiting for lifecycle lock for workspace "${name}". A previous Agent Containers command may still be running.`, cause === undefined ? undefined : { cause });
}

function malformedLockError(name: string, lockPath: string, cause?: unknown): Error {
  return new Error(`Lifecycle lock for workspace "${name}" has malformed owner metadata. Agent Containers cannot identify a PID and will not remove it. After independently verifying no Agent Containers process can still own the workspace, perform manual filesystem repair: remove ${lockPath}, then retry the original lifecycle operation.`, cause === undefined ? undefined : { cause });
}

function delay(): Promise<void> {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
}

function isLockOwner(value: unknown): value is LockOwner {
  const candidate = typeof value === 'object' && value !== null ? value as { pid?: unknown; token?: unknown; createdAt?: unknown } : undefined;
  return Number.isInteger(candidate?.pid) && typeof candidate?.pid === 'number' && candidate.pid > 0 &&
    typeof candidate.token === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.token) &&
    (candidate.createdAt === undefined || typeof candidate.createdAt === 'string');
}

function localPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, 'ESRCH')) return false;
    return true;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
