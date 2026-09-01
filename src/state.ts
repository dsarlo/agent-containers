import { lstat, mkdir, open, readdir, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isValidWorkspaceName, validateWorkspaceName } from './names.js';
import { getProductionStateDurabilityAdapter, type StateDurabilityAdapter } from './durability.js';

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
  reason: 'operation-may-be-active' | 'remote-exec-interrupted' | 'devcontainer-up-ambiguous' | 'local-process-reap-unconfirmed';
  containerIds: string[];
  worktree: string;
  createdAt: string;
}

export interface ManualRecoveryInput {
  reason: ManualRecovery['reason'];
  containerIds: string[];
  worktree: string;
}

let testDurabilityAdapter: StateDurabilityAdapter | undefined;

/** Test-only injection point so state behavior can be exercised without a compiled host addon. */
export function setStateDurabilityAdapterForTesting(adapter: StateDurabilityAdapter | undefined): void {
  testDurabilityAdapter = adapter;
}

function stateDurability(adapter?: StateDurabilityAdapter): StateDurabilityAdapter {
  return adapter ?? testDurabilityAdapter ?? getProductionStateDurabilityAdapter();
}

export function defaultStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-containers');
}

export function metadataPath(stateDir: string, name: string): string {
  return join(stateDir, 'workspaces', `${validateWorkspaceName(name)}.json`);
}

function legacyManualRecoveryPath(stateDir: string, name: string): string {
  return join(stateDir, 'locks', `${validateWorkspaceName(name)}.manual-recovery.json`);
}

function manualRecoveryJournalPath(stateDir: string, name: string): string {
  return join(stateDir, 'locks', `${validateWorkspaceName(name)}.manual-recovery.journal`);
}

type ManualRecoveryJournalEvent = { event: 'set'; recovery: ManualRecovery } | { event: 'clear' };
type CheckedManualRecoveryJournalEvent = ManualRecoveryJournalEvent & { checksum: string };

/**
 * Safely establish the append-only recovery journal. Existing workspaces must
 * retry after this one-time durable initialization, so remote work never starts
 * immediately after the journal itself was first published.
 */
export async function bootstrapManualRecoveryJournal(stateDir: string, name: string): Promise<boolean> {
  const lockName = validateWorkspaceName(name);
  const directory = join(stateDir, 'locks');
  const path = manualRecoveryJournalPath(stateDir, lockName);
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  await ensureDurableDirectory(directory, durability);
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const legacy = await loadLegacyManualRecovery(stateDir, lockName);
  if (await durability.publicationMode() === 'recoverable') {
    const stagingPath = join(directory, `.${lockName}.${randomUUID()}.manual-recovery.journal.tmp`);
    let stagingFile: FileHandle | undefined;
    try {
      stagingFile = await open(stagingPath, 'wx', 0o600);
      await stagingFile.close();
      stagingFile = undefined;
      await durability.syncFile(stagingPath);
      // Windows cannot flush directories. MoveFileExW with REPLACE_EXISTING and
      // WRITE_THROUGH is its atomic, durable old-valid-or-new-valid boundary.
      await durability.moveFileWriteThrough(stagingPath, path);
    } catch (error: unknown) {
      await stagingFile?.close();
      await rm(stagingPath, { force: true });
      throw error;
    }
  } else {
    let file: FileHandle | undefined;
    try {
      file = await open(path, 'wx', 0o600);
      await file.close();
      file = undefined;
      await durability.syncFile(path);
      await syncDirectory(directory, durability);
    } catch (error: unknown) {
      await file?.close();
      if (isNodeError(error, 'EEXIST')) return false;
      throw error;
    }
  }
  // Previous releases had a replacement marker. Preserve it as a durable set
  // event so upgrade can never silently release an old manual-recovery block.
  if (legacy) await appendManualRecoveryJournalEvent(path, { event: 'set', recovery: legacy }, durability);
  return true;
}

/** Persist an append-only, checksummed recovery barrier before remote lifecycle work. */
export async function recordManualRecovery(stateDir: string, name: string, input: ManualRecoveryInput): Promise<void> {
  const recovery: ManualRecovery = { version: 1, ...input, createdAt: new Date().toISOString() };
  if (!isManualRecovery(recovery)) throw new Error('Refusing to save invalid manual recovery state.');
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  await bootstrapManualRecoveryJournal(stateDir, name);
  await appendManualRecoveryJournalEvent(manualRecoveryJournalPath(stateDir, name), { event: 'set', recovery }, durability);
}

async function appendManualRecoveryJournalEvent(path: string, event: ManualRecoveryJournalEvent, durability: StateDurabilityAdapter): Promise<void> {
  const entry: CheckedManualRecoveryJournalEvent = { ...event, checksum: journalChecksum(event) };
  let file: FileHandle | undefined;
  try {
    file = await open(path, 'a', 0o600);
    await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await file.close();
    file = undefined;
    // The regular-file flush is the durable recovery guard on macOS and the
    // Windows old-valid-or-new-valid publication protocol.
    await durability.syncFile(path);
  } catch (error: unknown) {
    await file?.close();
    throw error;
  }
}

async function durableReplace(temporaryPath: string, path: string, directory: string, content: string, durability: StateDurabilityAdapter): Promise<void> {
  let file: FileHandle | undefined;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.close();
    file = undefined;
    await durability.syncFile(temporaryPath);
    if (await durability.publicationMode() === 'recoverable') await durability.moveFileWriteThrough(temporaryPath, path);
    else await rename(temporaryPath, path);
    await syncDirectory(directory, durability);
  } catch (error: unknown) {
    await file?.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function loadManualRecovery(stateDir: string, name: string): Promise<ManualRecovery | undefined> {
  const journalPath = manualRecoveryJournalPath(stateDir, name);
  try {
    return parseManualRecoveryJournal(await readFile(journalPath, 'utf8'), name);
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
    return loadLegacyManualRecovery(stateDir, name);
  }
}

async function loadLegacyManualRecovery(stateDir: string, name: string): Promise<ManualRecovery | undefined> {
  try {
    const recovery: unknown = JSON.parse(await readFile(legacyManualRecoveryPath(stateDir, name), 'utf8'));
    if (!isManualRecovery(recovery)) throw new Error(`Manual recovery state for ${name} is invalid; refusing to release lifecycle protection.`);
    return recovery;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function parseManualRecoveryJournal(source: string, name: string): ManualRecovery | undefined {
  const lines = source.split('\n');
  const hasPartialTail = source.length > 0 && !source.endsWith('\n');
  if (hasPartialTail) lines.pop();
  let recovery: ManualRecovery | undefined;
  for (const line of lines) {
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { throw new Error(`Manual recovery journal for ${name} is corrupt before its final record; refusing to release lifecycle protection.`); }
    if (!isCheckedManualRecoveryJournalEvent(entry)) throw new Error(`Manual recovery journal for ${name} is corrupt before its final record; refusing to release lifecycle protection.`);
    if (entry.event === 'set') recovery = entry.recovery;
    else recovery = undefined;
  }
  return recovery;
}

function isCheckedManualRecoveryJournalEvent(value: unknown): value is CheckedManualRecoveryJournalEvent {
  if (typeof value !== 'object' || value === null || !('event' in value) || !('checksum' in value) || typeof value.checksum !== 'string') return false;
  if (value.event === 'clear') return value.checksum === journalChecksum({ event: 'clear' });
  return value.event === 'set' && 'recovery' in value && isManualRecovery(value.recovery) && value.checksum === journalChecksum({ event: 'set', recovery: value.recovery });
}

function journalChecksum(event: ManualRecoveryJournalEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

/** This is deliberately separate from `unlock`: it records an operator's explicit remote-state acknowledgement. */
export async function clearManualRecovery(stateDir: string, name: string): Promise<void> {
  if (!await loadManualRecovery(stateDir, name)) throw new Error(`No manual recovery block exists for workspace "${name}".`);
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  await bootstrapManualRecoveryJournal(stateDir, name);
  await appendManualRecoveryJournalEvent(manualRecoveryJournalPath(stateDir, name), { event: 'clear' }, durability);
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
  if (metadata.containerId !== undefined && !isCanonicalContainerId(metadata.containerId)) throw new Error('Refusing to save a non-canonical Docker container ID.');
  const path = metadataPath(stateDir, metadata.name);
  const directory = join(stateDir, 'workspaces');
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  await ensureDurableDirectory(directory, durability);
  const temporaryPath = join(directory, `.${metadata.name}.${randomUUID()}.tmp`);
  await durableReplace(temporaryPath, path, directory, `${JSON.stringify(metadata, null, 2)}\n`, durability);
}

export function isCanonicalContainerId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export async function deleteMetadata(stateDir: string, name: string): Promise<void> {
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  await durableRemove(metadataPath(stateDir, name), join(stateDir, 'workspaces'), true, durability);
}

export async function listMetadata(stateDir: string): Promise<WorkspaceMetadata[]> {
  try {
    const files = await readdir(join(stateDir, 'workspaces'));
    const names = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5));
    const entries: Array<WorkspaceMetadata | undefined> = [];
    // Keep status reads bounded while preserving filesystem enumeration order.
    for (let index = 0; index < names.length; index += METADATA_LIST_CONCURRENCY) {
      entries.push(...await Promise.all(names.slice(index, index + METADATA_LIST_CONCURRENCY).map((name) => loadMetadata(stateDir, name))));
    }
    return entries.filter((entry): entry is WorkspaceMetadata => entry !== undefined);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export const METADATA_LIST_CONCURRENCY = 8;

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
    (!('containerId' in metadata) || metadata.containerId === undefined || typeof metadata.containerId === 'string') &&
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
    (candidate.reason === 'operation-may-be-active' || candidate.reason === 'remote-exec-interrupted' || candidate.reason === 'devcontainer-up-ambiguous' || candidate.reason === 'local-process-reap-unconfirmed') &&
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
  /** Explicit adapter injection for tests and embedders that provide equivalent native durability. */
  durabilityAdapter?: StateDurabilityAdapter;
}

export type LockPublicationStep = 'owner-file-synced' | 'staging-directory-synced' | 'published' | 'locks-directory-synced';
export interface StateDirectoryDurabilityStep {
  kind: 'created' | 'directory-synced' | 'parent-directory-synced';
  path: string;
}

export async function withWorkspaceLock<T>(stateDir: string, name: string, action: (signal: AbortSignal) => Promise<T>, options: number | WorkspaceLockOptions = 30_000): Promise<T> {
  const { timeoutMs, abortSignal, allowManualRecovery, onLockPublication, onStateDirectoryDurability, durabilityAdapter } = typeof options === 'number'
    ? { timeoutMs: options, abortSignal: undefined, allowManualRecovery: false, onLockPublication: undefined, onStateDirectoryDurability: undefined, durabilityAdapter: undefined }
    : { timeoutMs: options.timeoutMs ?? 30_000, abortSignal: options.abortSignal, allowManualRecovery: options.allowManualRecovery ?? false, onLockPublication: options.onLockPublication, onStateDirectoryDurability: options.onStateDirectoryDurability, durabilityAdapter: options.durabilityAdapter };
  const durability = stateDurability(durabilityAdapter);
  await durability.assertStateWriteSupport();
  const lockName = validateWorkspaceName(name);
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, `${lockName}.lock`);
  const recoveryPath = join(locksDir, `${lockName}.recovery`);
  await ensureDurableDirectory(locksDir, durability, onStateDirectoryDurability);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await waitForRecoveryToFinish(recoveryPath, deadline, name, durability);
    if (await acquireOwnedDirectory(lockPath, locksDir, lockName, deadline, name, durability, onLockPublication)) break;
  }
  try {
    if (!allowManualRecovery && await loadManualRecovery(stateDir, lockName)) throw manualRecoveryError(name);
  } catch (error) {
    await durableRemove(lockPath, locksDir, true, durability);
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
    await durableRemove(lockPath, locksDir, true, durability);
    if (receivedSignal) process.kill(process.pid, receivedSignal);
  }
}

/** Release only a lock whose recorded local owner PID is proven no longer alive. */
export async function releaseStaleWorkspaceLock(stateDir: string, name: string, isPidAlive: (pid: number) => boolean = localPidIsAlive, hooks: StaleLockRecoveryHooks = {}, timeoutMs = 30_000): Promise<void> {
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  const lockName = validateWorkspaceName(name);
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, `${lockName}.lock`);
  const recoveryPath = join(locksDir, `${lockName}.recovery`);
  await ensureDurableDirectory(locksDir, durability);
  if (await loadManualRecovery(stateDir, lockName)) throw manualRecoveryError(name);
  await acquireRecoveryLock(recoveryPath, locksDir, lockName, Date.now() + timeoutMs, name, isPidAlive, durability);
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
    await durableRename(lockPath, reclaimedPath, locksDir, durability);
    await durableRemove(reclaimedPath, locksDir, false, durability);
  } finally {
    await durableRemove(recoveryPath, locksDir, true, durability);
  }
}

async function waitForRecoveryToFinish(recoveryPath: string, deadline: number, name: string, durability: StateDurabilityAdapter): Promise<void> {
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
        await durableRename(recoveryPath, abandonedPath, dirname(recoveryPath), durability);
        await durableRemove(abandonedPath, dirname(recoveryPath), false, durability);
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

async function acquireRecoveryLock(recoveryPath: string, locksDir: string, lockName: string, deadline: number, name: string, isPidAlive: (pid: number) => boolean, durability: StateDurabilityAdapter): Promise<void> {
  while (true) {
    await reclaimDeadPublishedLock(recoveryPath, isPidAlive, durability);
    if (await acquireOwnedDirectory(recoveryPath, locksDir, `${lockName}.recovery`, deadline, name, durability)) return;
  }
}

async function reclaimDeadPublishedLock(path: string, isPidAlive: (pid: number) => boolean, durability: StateDurabilityAdapter): Promise<void> {
  const owner = await readLockOwner(path);
  if (!owner || isPidAlive(owner.pid)) return;
  const abandonedPath = `${path}.${owner.token}.abandoned`;
  try {
    await durableRename(path, abandonedPath, dirname(path), durability);
    await durableRemove(abandonedPath, dirname(path), false, durability);
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

/** Build owner metadata off-path, then atomically publish the directory. */
async function acquireOwnedDirectory(path: string, locksDir: string, temporaryStem: string, deadline: number, name: string, durability: StateDurabilityAdapter, onLockPublication?: (step: LockPublicationStep) => void | Promise<void>): Promise<boolean> {
  const temporaryPath = join(locksDir, `.${temporaryStem}.${randomUUID()}.pending`);
  let ownerFile: FileHandle | undefined;
  try {
    await mkdir(temporaryPath, { recursive: false, mode: 0o700 });
    const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    const ownerPath = join(temporaryPath, 'owner.json');
    ownerFile = await open(ownerPath, 'wx', 0o600);
    await ownerFile.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await ownerFile.close();
    ownerFile = undefined;
    await durability.syncFile(ownerPath);
    await onLockPublication?.('owner-file-synced');
    await syncDirectory(temporaryPath, durability);
    await onLockPublication?.('staging-directory-synced');
    if (await durability.publicationMode() === 'recoverable') await durability.moveFileWriteThrough(temporaryPath, path);
    else await rename(temporaryPath, path);
    await onLockPublication?.('published');
    await syncDirectory(locksDir, durability);
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

async function ensureDurableDirectory(directory: string, durability: StateDurabilityAdapter, onDurabilityStep?: (step: StateDirectoryDurabilityStep) => void | Promise<void>): Promise<void> {
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
    await syncDirectory(createdDirectory, durability);
    await onDurabilityStep?.({ kind: 'directory-synced', path: createdDirectory });
    await syncDirectory(parent, durability);
    await onDurabilityStep?.({ kind: 'parent-directory-synced', path: parent });
  }
}

async function syncDirectory(directory: string, durability: StateDurabilityAdapter): Promise<void> {
  // The native adapter makes this a no-op only for recoverable Windows mode;
  // avoid calling it at all so callers cannot mistake it for a directory flush.
  if (await durability.publicationMode() === 'recoverable') return;
  await durability.syncDirectory(directory);
}

async function durableRename(source: string, destination: string, directory: string, durability: StateDurabilityAdapter): Promise<void> {
  if (await durability.publicationMode() === 'recoverable') await durability.moveFileWriteThrough(source, destination);
  else await rename(source, destination);
  await syncDirectory(directory, durability);
}

async function durableRemove(path: string, directory: string, force: boolean, durability: StateDurabilityAdapter): Promise<void> {
  await rm(path, { recursive: true, force });
  await syncDirectory(directory, durability);
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
