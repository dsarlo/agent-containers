import { lstat, mkdir, open, readdir, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isValidWorkspaceName, validateWorkspaceName } from './names.js';
import { getProductionStateDurabilityAdapter, type StateDurabilityAdapter } from './durability.js';
import type { WorkspaceHandle } from './types.js';

export interface LocalWorkspaceMetadata {
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

/** Schema v2 records the selected backend and a discriminated backend handle. */
export interface V2LocalWorkspaceMetadata extends Omit<LocalWorkspaceMetadata, 'version'> {
  version: 2;
  backend: 'local';
  handle: Extract<WorkspaceHandle, { kind: 'local' }>;
}
/** Remote records intentionally have no local worktree, branch, or Docker fields. */
export interface CodespacesWorkspaceMetadata {
  version: 2;
  backend: 'codespaces';
  name: string;
  workspaceId: string;
  createdAt: string;
  control: { githubHost: string; actorId: string; actorLogin: string; ghVersion: string };
  repository: { id: string; owner: string; name: string };
  source: { requestedRef: string; expectedOid: string; effectiveBranch: string; devcontainerPath: string; devcontainerBlobOid: string };
  remote: { codespaceId: string; name: string; environmentId: string; ownerId: string; ownerLogin: string; billableOwnerId: string; machine: string; geo: string; createdAt: string };
  lifecycle: { desired: 'ready' | 'stopped'; normalized: string; providerRawState: string; lastObservedAt: string; activeOperation: null | { id: string; kind: 'create' | 'stop' | 'remove'; startedAt: string; checkpoint: string } };
  recovery: null | { reason: string; operationId: string; recordedAt: string };
  cleanup: { remoteStopped: boolean; remoteDeleted: boolean; tombstoneWritten: boolean };
}
export type WorkspaceMetadata = LocalWorkspaceMetadata | V2LocalWorkspaceMetadata | CodespacesWorkspaceMetadata;
export type LocalMetadata = LocalWorkspaceMetadata | V2LocalWorkspaceMetadata;

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
  /** Immutable identity used to prevent a stale acknowledgement clearing a later barrier. */
  generation: string;
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
let testDurableRename: ((source: string, destination: string) => Promise<void>) | undefined;
let testJournalStagingWrite: ((file: FileHandle, content: string) => Promise<void>) | undefined;
const journalSerializers = new Map<string, Promise<void>>();

/** Serialize every local journal transition; filesystem durability handles crashes. */
async function withManualRecoveryJournalSerialization<T>(stateDir: string, name: string, action: () => Promise<T>): Promise<T> {
  const path = manualRecoveryJournalPath(stateDir, name);
  const previous = journalSerializers.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  journalSerializers.set(path, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (journalSerializers.get(path) === queued) journalSerializers.delete(path);
  }
}

/** Test-only injection point so state behavior can be exercised without a compiled host addon. */
export function setStateDurabilityAdapterForTesting(adapter: StateDurabilityAdapter | undefined): void {
  testDurabilityAdapter = adapter;
}

/** Test-only seam for a filesystem move that fails before changing either path. */
export function setStateDurableRenameForTesting(renameForTest: ((source: string, destination: string) => Promise<void>) | undefined): void {
  testDurableRename = renameForTest;
}

/** Test-only seam for a staging write failure before its file durability boundary. */
export function setStateJournalStagingWriteForTesting(writer: ((file: FileHandle, content: string) => Promise<void>) | undefined): void {
  testJournalStagingWrite = writer;
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

function manualRecoveryClearFailsafePath(stateDir: string, name: string): string {
  return join(stateDir, 'locks', `${validateWorkspaceName(name)}.manual-recovery.clear-failsafe.json`);
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
  return withManualRecoveryJournalSerialization(stateDir, name, () => bootstrapManualRecoveryJournalUnsafe(stateDir, name));
}

async function bootstrapManualRecoveryJournalUnsafe(stateDir: string, name: string): Promise<boolean> {
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
  const initialEvent: CheckedManualRecoveryJournalEvent | undefined = legacy
    ? { event: 'set', recovery: legacy, checksum: journalChecksum({ event: 'set', recovery: legacy }) }
    : undefined;
  const initialJournal = initialEvent ? `${JSON.stringify(initialEvent)}\n` : '';
  if (await durability.publicationMode() === 'recoverable') {
    const stagingPath = join(directory, `.${lockName}.${randomUUID()}.manual-recovery.journal.tmp`);
    let stagingFile: FileHandle | undefined;
    try {
      stagingFile = await open(stagingPath, 'wx', 0o600);
      await (testJournalStagingWrite ?? ((file, content) => file.writeFile(content, 'utf8')))(stagingFile, initialJournal);
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
    const stagingPath = join(directory, `.${lockName}.${randomUUID()}.manual-recovery.journal.tmp`);
    let file: FileHandle | undefined;
    try {
      file = await open(stagingPath, 'wx', 0o600);
      await (testJournalStagingWrite ?? ((handle, content) => handle.writeFile(content, 'utf8')))(file, initialJournal);
      await file.close();
      file = undefined;
      await durability.syncFile(stagingPath);
      await durableRename(stagingPath, path, directory, durability);
    } catch (error: unknown) {
      await file?.close();
      await rm(stagingPath, { force: true });
      throw error;
    }
  }
  return true;
}

/** Persist an append-only, checksummed recovery barrier before remote lifecycle work. */
export async function recordManualRecovery(stateDir: string, name: string, input: ManualRecoveryInput): Promise<void> {
  await withManualRecoveryJournalSerialization(stateDir, name, async () => {
    const recovery: ManualRecovery = { version: 1, generation: randomUUID(), ...input, containerIds: [...new Set(input.containerIds.filter(isCanonicalContainerId))], createdAt: new Date().toISOString() };
    if (!isManualRecovery(recovery)) throw new Error('Refusing to save invalid manual recovery state.');
    const durability = stateDurability();
    await durability.assertStateWriteSupport();
    await bootstrapManualRecoveryJournalUnsafe(stateDir, name);
    await appendManualRecoveryJournalEvent(manualRecoveryJournalPath(stateDir, name), { event: 'set', recovery }, durability);
    // A prior failed clear may have retained its older failsafe. The new journal
    // set is authoritative, so it is safe to retire that stale barrier now.
    await durableRemove(manualRecoveryClearFailsafePath(stateDir, name), join(stateDir, 'locks'), true, durability);
  });
}

async function appendManualRecoveryJournalEvent(path: string, event: ManualRecoveryJournalEvent, durability: StateDurabilityAdapter): Promise<void> {
  const source = await readFile(path, 'utf8');
  const committed = source.endsWith('\n') ? source : source.slice(0, source.lastIndexOf('\n') + 1);
  const entry: CheckedManualRecoveryJournalEvent = { ...event, checksum: journalChecksum(event) };
  // Never append a clear in-place: a write that reaches page cache but fails
  // its durability boundary must leave the old barrier authoritative.
  await durableReplace(join(dirname(path), `.${randomUUID()}.manual-recovery.journal.tmp`), path, dirname(path), `${committed}${JSON.stringify(entry)}\n`, durability);
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
  // A clear record whose parent-directory durability boundary failed can be
  // visible despite not being crash durable. Its separately published
  // failsafe remains authoritative until it is durably removed.
  const failsafe = await loadManualRecoveryFile(manualRecoveryClearFailsafePath(stateDir, name), name);
  try {
    const source = await readFile(journalPath, 'utf8');
    const recovery = parseManualRecoveryJournal(source, name);
    if (recovery) return recovery;
    if (failsafe) return failsafe;
    // An empty authoritative journal from an interrupted older migration is
    // not evidence that its legacy barrier was cleared.
    return source.trim() === '' ? loadLegacyManualRecovery(stateDir, name) : undefined;
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
    if (failsafe) return failsafe;
    return loadLegacyManualRecovery(stateDir, name);
  }
}

async function loadLegacyManualRecovery(stateDir: string, name: string): Promise<ManualRecovery | undefined> {
  return loadManualRecoveryFile(legacyManualRecoveryPath(stateDir, name), name);
}

async function loadManualRecoveryFile(path: string, name: string): Promise<ManualRecovery | undefined> {
  try {
    const recovery: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isStoredManualRecovery(recovery)) throw new Error(`Manual recovery state for ${name} is invalid; refusing to release lifecycle protection.`);
    return normalizeManualRecovery(recovery);
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
    if (entry.event === 'set') recovery = normalizeManualRecovery(entry.recovery);
    else recovery = undefined;
  }
  return recovery;
}

function isCheckedManualRecoveryJournalEvent(value: unknown): value is CheckedManualRecoveryJournalEvent {
  if (typeof value !== 'object' || value === null || !('event' in value) || !('checksum' in value) || typeof value.checksum !== 'string') return false;
  if (value.event === 'clear') return value.checksum === journalChecksum({ event: 'clear' });
  return value.event === 'set' && 'recovery' in value && isStoredManualRecovery(value.recovery) && value.checksum === journalChecksum({ event: 'set', recovery: value.recovery });
}

function journalChecksum(event: ManualRecoveryJournalEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

/** This is deliberately separate from `unlock`: it records an operator's explicit remote-state acknowledgement. */
export async function clearManualRecovery(stateDir: string, name: string): Promise<void> {
  const recovery = await loadManualRecovery(stateDir, name);
  if (!recovery) throw new Error(`No manual recovery block exists for workspace "${name}".`);
  await clearManualRecoveryIfCurrent(stateDir, name, recovery.generation);
}

/** Clear only the exact recovery barrier the caller observed while holding its lifecycle lock. */
export async function clearManualRecoveryIfCurrent(stateDir: string, name: string, generation: string): Promise<void> {
  await withManualRecoveryJournalSerialization(stateDir, name, async () => {
    const current = await loadManualRecovery(stateDir, name);
    if (!current) throw new Error(`No manual recovery block exists for workspace "${name}".`);
    if (current.generation !== generation) throw new Error(`Manual recovery block for workspace "${name}" changed since it was acknowledged; refusing to clear the newer record.`);
    const durability = stateDurability();
    await durability.assertStateWriteSupport();
    await bootstrapManualRecoveryJournalUnsafe(stateDir, name);
    const directory = join(stateDir, 'locks');
    // Keep a separately durable copy until the journal clear is fully published.
    // A failed removal leaves the journal authoritative; a failed clear leaves
    // this published copy authoritative.
    const failsafePath = manualRecoveryClearFailsafePath(stateDir, name);
    await durableReplace(join(directory, `.${randomUUID()}.manual-recovery.clear-failsafe.tmp`), failsafePath, directory, `${JSON.stringify(current)}\n`, durability);
    await appendManualRecoveryJournalEvent(manualRecoveryJournalPath(stateDir, name), { event: 'clear' }, durability);
    // The clear is now durable. Once unlink succeeds, only its strict
    // directory-sync uncertainty remains, so acknowledge the clear rather
    // than error-returning after lifecycle has become admissible.
    await retireClearFailsafeAfterCommittedJournalClear(failsafePath, directory, durability);
  });
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
  if (isLocalWorkspaceMetadata(metadata) && metadata.containerId !== undefined && !isCanonicalContainerId(metadata.containerId)) throw new Error('Refusing to save a non-canonical Docker container ID.');
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
    const names = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort();
    const entries: Array<WorkspaceMetadata | undefined> = [];
    // Keep status reads bounded and deterministic regardless of filesystem order.
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
  if (isCodespacesWorkspace(metadata)) return true;
  return typeof metadata === 'object' && metadata !== null &&
    'version' in metadata && (metadata.version === 1 || metadata.version === 2) &&
    'name' in metadata && typeof metadata.name === 'string' && isValidWorkspaceName(metadata.name) &&
    'branch' in metadata && metadata.branch === `agent-containers/${metadata.name}` &&
    'worktree' in metadata && isCanonicalPath(metadata.worktree) &&
    'repoRoot' in metadata && isCanonicalPath(metadata.repoRoot) &&
    'baseRef' in metadata && isLocalBranchRef(metadata.baseRef) &&
    'devcontainerPath' in metadata && typeof metadata.devcontainerPath === 'string' &&
    'createdAt' in metadata && typeof metadata.createdAt === 'string' &&
    (!('containerId' in metadata) || metadata.containerId === undefined || (typeof metadata.containerId === 'string' && metadata.containerId.length > 0)) &&
    (!('cleanup' in metadata) || metadata.cleanup === undefined || isCleanupState(metadata.cleanup)) &&
    (metadata.version === 1 || (isKnownLocalV2Record(metadata) && 'backend' in metadata && metadata.backend === 'local' && 'handle' in metadata && isLocalHandle(metadata.handle)));
}

export function isLocalWorkspaceMetadata(metadata: WorkspaceMetadata): metadata is LocalMetadata {
  return metadata.version === 1 || metadata.backend === 'local';
}
function isKnownLocalV2Record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).every((key) => ['version', 'backend', 'handle', 'name', 'repoRoot', 'worktree', 'branch', 'baseRef', 'devcontainerPath', 'createdAt', 'containerId', 'cleanup'].includes(key) && !/(token|secret|password|credential|key)/i.test(key));
}
function isLocalHandle(value: unknown): boolean { return isStrictRecord(value, ['kind']) && value.kind === 'local'; }
function isCodespacesWorkspace(value: unknown): value is CodespacesWorkspaceMetadata {
  if (!isStrictRecord(value, ['version', 'backend', 'name', 'workspaceId', 'createdAt', 'control', 'repository', 'source', 'remote', 'lifecycle', 'recovery', 'cleanup']) || value.version !== 2 || value.backend !== 'codespaces' || typeof value.name !== 'string' || !isValidWorkspaceName(value.name) || !isUuid(value.workspaceId) || !isTimestamp(value.createdAt)) return false;
  const control = value.control, repository = value.repository, source = value.source, remote = value.remote, lifecycle = value.lifecycle, cleanup = value.cleanup;
  if (!isStrictRecord(control, ['githubHost', 'actorId', 'actorLogin', 'ghVersion']) || control.githubHost !== 'github.com' || !losslessId(control.actorId) || !safeDisplay(control.actorLogin) || !safeDisplay(control.ghVersion)) return false;
  if (!isStrictRecord(repository, ['id', 'owner', 'name']) || !losslessId(repository.id) || !safeIdentifier(repository.owner) || !safeIdentifier(repository.name)) return false;
  if (!isStrictRecord(source, ['requestedRef', 'expectedOid', 'effectiveBranch', 'devcontainerPath', 'devcontainerBlobOid']) || !safeRef(source.requestedRef) || source.effectiveBranch !== `agent-containers/${value.name}` || !isOid(source.expectedOid) || !safeRepositoryPath(source.devcontainerPath) || !isOid(source.devcontainerBlobOid)) return false;
  if (!isStrictRecord(remote, ['codespaceId', 'name', 'environmentId', 'ownerId', 'ownerLogin', 'billableOwnerId', 'machine', 'geo', 'createdAt']) || !losslessId(remote.codespaceId) || !safeDisplay(remote.name) || !safeDisplay(remote.environmentId) || !losslessId(remote.ownerId) || !safeDisplay(remote.ownerLogin) || !losslessId(remote.billableOwnerId) || !safeDisplay(remote.machine) || !safeDisplay(remote.geo) || !isTimestamp(remote.createdAt)) return false;
  if (!isStrictRecord(lifecycle, ['desired', 'normalized', 'providerRawState', 'lastObservedAt', 'activeOperation']) || (lifecycle.desired !== 'ready' && lifecycle.desired !== 'stopped') || !safeDisplay(lifecycle.normalized) || !safeDisplay(lifecycle.providerRawState) || !isTimestamp(lifecycle.lastObservedAt) || !validOperation(lifecycle.activeOperation)) return false;
  if (value.recovery !== null && (!isStrictRecord(value.recovery, ['reason', 'operationId', 'recordedAt']) || !safeDisplay(value.recovery.reason) || !isUuid(value.recovery.operationId) || !isTimestamp(value.recovery.recordedAt))) return false;
  return isStrictRecord(cleanup, ['remoteStopped', 'remoteDeleted', 'tombstoneWritten']) && typeof cleanup.remoteStopped === 'boolean' && typeof cleanup.remoteDeleted === 'boolean' && typeof cleanup.tombstoneWritten === 'boolean';
}

function isStrictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key) && !/(token|secret|password|credential|key)/i.test(key)); }
function losslessId(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]*$/.test(value); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function isOid(value: unknown): value is string { return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value); }
function safeIdentifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
function safeDisplay(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value) && !/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN)/i.test(value); }
function safeRef(value: unknown): value is string { return typeof value === 'string' && value.length <= 512 && /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..') && !value.endsWith('.'); }
function safeRepositoryPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !/[\0\r\n\\]/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..'); }
function validOperation(value: unknown): boolean { return value === null || (isStrictRecord(value, ['id', 'kind', 'startedAt', 'checkpoint']) && isUuid(value.id) && (value.kind === 'create' || value.kind === 'stop' || value.kind === 'remove') && isTimestamp(value.startedAt) && safeDisplay(value.checkpoint)); }

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
    (!('generation' in candidate) || candidate.generation === undefined || (typeof candidate.generation === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.generation))) &&
    (candidate.reason === 'operation-may-be-active' || candidate.reason === 'remote-exec-interrupted' || candidate.reason === 'devcontainer-up-ambiguous' || candidate.reason === 'local-process-reap-unconfirmed') &&
    Array.isArray(candidate.containerIds) && candidate.containerIds.every(isCanonicalContainerId) &&
    isCanonicalPath(candidate.worktree) && typeof candidate.createdAt === 'string';
}

function isStoredManualRecovery(value: unknown): value is ManualRecovery {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<ManualRecovery> : undefined;
  return candidate?.version === 1 &&
    (!('generation' in candidate) || candidate.generation === undefined || (typeof candidate.generation === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.generation))) &&
    (candidate.reason === 'operation-may-be-active' || candidate.reason === 'remote-exec-interrupted' || candidate.reason === 'devcontainer-up-ambiguous' || candidate.reason === 'local-process-reap-unconfirmed') &&
    Array.isArray(candidate.containerIds) && candidate.containerIds.every((id) => isCanonicalContainerId(id) || /^[a-f0-9]{12}$/.test(id)) &&
    isCanonicalPath(candidate.worktree) && typeof candidate.createdAt === 'string';
}

function normalizeManualRecovery(recovery: ManualRecovery): ManualRecovery {
  const normalized = { ...recovery, containerIds: recovery.containerIds.filter(isCanonicalContainerId) };
  if (typeof normalized.generation === 'string') return normalized;
  // Legacy durable records predate generations. Their content-derived identity
  // must include stored short hints, even though those hints are never actionable.
  return { ...normalized, generation: `00000000-0000-4000-8000-${createHash('sha256').update(JSON.stringify(recovery)).digest('hex').slice(0, 12)}` };
}

function manualRecoveryError(name: string): Error {
  return new Error(`Workspace "${name}" is blocked by durable manual recovery because a remote Dev Container operation may still be active. Verify the remote command/container state, then run agent-containers recover ${name} --yes --remote-command-stopped. The ordinary unlock command never clears this block.`);
}

function guardedLockRecoveryError(name: string): Error {
  return new Error(`Lifecycle lock for workspace "${name}" is a current guarded crash-recovery lock. Ordinary unlock never clears it; verify remote state, then run agent-containers recover ${name} --yes --remote-command-stopped.`);
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
  /** Persist a recovery boundary before releasing this lock after a lifecycle child cannot be reaped. */
  onUnconfirmedProcessReap?: (error: Error) => Promise<void>;
  /** Test seam for marker open/write failures; production uses the durable marker writer. */
  writeUnconfirmedReapMarker?: (lockPath: string, durability: StateDurabilityAdapter) => Promise<void>;
}

export type LockPublicationStep = 'owner-file-synced' | 'staging-directory-synced' | 'published' | 'locks-directory-synced';
export interface StateDirectoryDurabilityStep {
  kind: 'created' | 'directory-synced' | 'parent-directory-synced';
  path: string;
}

export async function withWorkspaceLock<T>(stateDir: string, name: string, action: (signal: AbortSignal) => Promise<T>, options: number | WorkspaceLockOptions = 30_000): Promise<T> {
  const { timeoutMs, abortSignal, allowManualRecovery, onLockPublication, onStateDirectoryDurability, durabilityAdapter, onUnconfirmedProcessReap, writeUnconfirmedReapMarker } = typeof options === 'number'
    ? { timeoutMs: options, abortSignal: undefined, allowManualRecovery: false, onLockPublication: undefined, onStateDirectoryDurability: undefined, durabilityAdapter: undefined, onUnconfirmedProcessReap: undefined, writeUnconfirmedReapMarker: undefined }
    : { timeoutMs: options.timeoutMs ?? 30_000, abortSignal: options.abortSignal, allowManualRecovery: options.allowManualRecovery ?? false, onLockPublication: options.onLockPublication, onStateDirectoryDurability: options.onStateDirectoryDurability, durabilityAdapter: options.durabilityAdapter, onUnconfirmedProcessReap: options.onUnconfirmedProcessReap, writeUnconfirmedReapMarker: options.writeUnconfirmedReapMarker };
  const durability = stateDurability(durabilityAdapter);
  await durability.assertStateWriteSupport();
  const lockName = validateWorkspaceName(name);
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, `${lockName}.lock`);
  const quarantinePath = join(locksDir, `${lockName}.reap-unconfirmed`);
  const recoveryPath = join(locksDir, `${lockName}.recovery`);
  await ensureDurableDirectory(locksDir, durability, onStateDirectoryDurability);
  const deadline = Date.now() + timeoutMs;
  // Hold this durable boundary for the entire lifecycle. A stale unlock or
  // recovery acknowledgement therefore cannot validate a normal lock while it
  // is being converted into a fail-closed uncertain-reap representation.
  const recoveryOwner = await acquireRecoveryLock(recoveryPath, locksDir, lockName, deadline, name, localPidIsAlive, durability);
  let lifecycleOwner: LockOwner | undefined;
  try {
    if (await hasUnconfirmedReapBarrier(lockPath, quarantinePath)) throw unconfirmedReapLockError(name);
    while (!(lifecycleOwner = await acquireOwnedDirectory(lockPath, locksDir, lockName, deadline, name, durability, onLockPublication))) {
      if (await hasUnconfirmedReapBarrier(lockPath, quarantinePath)) throw unconfirmedReapLockError(name);
    }
  } catch (error) {
    await retireOwnedLock(recoveryPath, locksDir, recoveryOwner, durability);
    throw error;
  }
  try {
    if (!allowManualRecovery && await loadManualRecovery(stateDir, lockName)) throw manualRecoveryError(name);
  } catch (error) {
    await retireOwnedLock(lockPath, locksDir, lifecycleOwner, durability);
    await retireOwnedLock(recoveryPath, locksDir, recoveryOwner, durability);
    throw error;
  }
  const cancellation = new AbortController();
  let releaseLock = true;
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
  } catch (error: unknown) {
    if (isUnconfirmedProcessReapError(error) && onUnconfirmedProcessReap) {
      try {
        await onUnconfirmedProcessReap(error);
      } catch (recoveryError: unknown) {
        // Preserve the published lock before attempting a move whose durability
        // result may be unknown. Ordinary unlock must never erase this boundary.
        releaseLock = false;
        try {
          await (writeUnconfirmedReapMarker ?? markUnconfirmedReap)(lockPath, durability);
        } catch {
          // A marker open, file flush, or parent publication failure cannot
          // skip quarantine. The recovery boundary remains held until the
          // retained lock has been moved or explicitly acknowledged.
        }
        try {
          const owner = await readLockOwner(lockPath);
          if (!owner) throw malformedLockError(name, lockPath);
          await moveOwnedLock(lockPath, quarantinePath, owner, locksDir, durability);
        } catch {
          // The retained marker is the durable fail-closed fallback when the
          // quarantine rename itself cannot be confirmed.
        }
        throw recoveryError;
      }
    }
    throw error;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    abortSignal?.removeEventListener('abort', cancel);
    if (releaseLock) await retireOwnedLock(lockPath, locksDir, lifecycleOwner, durability);
    await retireOwnedLock(recoveryPath, locksDir, recoveryOwner, durability);
    if (receivedSignal) process.kill(process.pid, receivedSignal);
  }
}

function isUnconfirmedProcessReapError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'UnconfirmedProcessReapError';
}

/** Release only a lock whose recorded local owner PID is proven no longer alive. */
export async function releaseStaleWorkspaceLock(stateDir: string, name: string, isPidAlive: (pid: number) => boolean = localPidIsAlive, hooks: StaleLockRecoveryHooks = {}, timeoutMs = 30_000): Promise<void> {
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  const lockName = validateWorkspaceName(name);
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, `${lockName}.lock`);
  const quarantinePath = join(locksDir, `${lockName}.reap-unconfirmed`);
  const recoveryPath = join(locksDir, `${lockName}.recovery`);
  await ensureDurableDirectory(locksDir, durability);
  const recoveryOwner = await acquireRecoveryLock(recoveryPath, locksDir, lockName, Date.now() + timeoutMs, name, isPidAlive, durability);
  try {
    if (await hasUnconfirmedReapBarrier(lockPath, quarantinePath)) throw unconfirmedReapLockError(name);
    if (await loadManualRecovery(stateDir, lockName)) throw manualRecoveryError(name);
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
    if (await pathExists(reapGuardPath(lockPath))) {
      throw guardedLockRecoveryError(name);
    }
    if (isPidAlive(owner.pid)) throw new Error(`Lifecycle lock for workspace "${name}" is owned by active PID ${owner.pid}; refusing to interrupt it.`);
    await hooks.beforeRemoval?.();
    const reclaimedPath = join(locksDir, `.${lockName}.${owner.token}.reclaimed`);
    await moveOwnedLock(lockPath, reclaimedPath, owner, locksDir, durability);
    await durableRemove(reclaimedPath, locksDir, false, durability);
  } finally {
    await retireOwnedLock(recoveryPath, locksDir, recoveryOwner, durability);
  }
}

/** Explicit recovery may retire a crashed current lock only after validating its guarded owner. */
export async function acknowledgeUnconfirmedProcessReap(stateDir: string, name: string, timeoutMs = 30_000): Promise<void> {
  const durability = stateDurability();
  await durability.assertStateWriteSupport();
  const lockName = validateWorkspaceName(name);
  const locksDir = join(stateDir, 'locks');
  const recoveryPath = join(locksDir, `${lockName}.recovery`);
  const quarantinePath = join(locksDir, `${lockName}.reap-unconfirmed`);
  await ensureDurableDirectory(locksDir, durability);
  const lockPath = join(locksDir, `${lockName}.lock`);
  const retainedMarker = unconfirmedReapMarkerPath(lockPath);
  const recoveryOwner = await acquireRecoveryLock(recoveryPath, locksDir, lockName, Date.now() + timeoutMs, name, localPidIsAlive, durability);
  let releaseRecoveryLock = true;
  try {
    if (await pathExists(quarantinePath)) {
      const owner = await readLockOwner(quarantinePath);
      if (!owner) throw malformedLockError(name, quarantinePath);
      if (localPidIsAlive(owner.pid)) throw new Error(`Lifecycle lock for workspace "${name}" is owned by active PID ${owner.pid}; refusing to interrupt it.`);
      await retireAcknowledgedLock(quarantinePath, quarantinePath, locksDir, lockName, name, owner, durability);
      return;
    }
    const owner = await readLockOwner(lockPath);
    if (!owner) {
      if (await pathExists(retainedMarker) || await pathExists(reapGuardPath(lockPath))) throw malformedLockError(name, lockPath);
      return;
    }
    if (await pathExists(retainedMarker)) {
      // The marker is inside a retained ordinary lock after a pre-move failure.
      // Retire it directly: retrying the failed lock-to-quarantine move would
      // make explicit recovery impossible when that transition is unavailable.
      if (localPidIsAlive(owner.pid)) throw new Error(`Lifecycle lock for workspace "${name}" is owned by active PID ${owner.pid}; refusing to interrupt it.`);
      await retireAcknowledgedLock(lockPath, quarantinePath, locksDir, lockName, name, owner, durability);
      return;
    }
    if (!await pathExists(reapGuardPath(lockPath))) return;
    if (localPidIsAlive(owner.pid)) throw new Error(`Lifecycle lock for workspace "${name}" is owned by active PID ${owner.pid}; refusing to interrupt it.`);
    await moveOwnedLock(lockPath, quarantinePath, owner, locksDir, durability);
    await retireAcknowledgedLock(quarantinePath, quarantinePath, locksDir, lockName, name, owner, durability);
  } catch (error: unknown) {
    // If every attempt to retain a recognized barrier failed after a destructive
    // boundary, retain the recovery lock rather than allowing lifecycle work.
    if (!await hasUnconfirmedReapBarrier(lockPath, quarantinePath)) releaseRecoveryLock = false;
    throw error;
  } finally {
    if (releaseRecoveryLock) await retireOwnedLock(recoveryPath, locksDir, recoveryOwner, durability);
  }
}

async function retireAcknowledgedLock(path: string, quarantinePath: string, locksDir: string, lockName: string, name: string, owner: LockOwner, durability: StateDurabilityAdapter): Promise<void> {
  try {
    // Publish a recognized barrier before retiring the source. A `.retired`
    // directory is intentionally never relied on as recovery state.
    if (path !== quarantinePath && !await pathExists(quarantinePath)) {
      await publishOwnedBarrier(quarantinePath, locksDir, `${lockName}.reap-unconfirmed`, owner, durability);
    }
    await durableRemoveOwned(path, locksDir, owner, durability);
    if (path !== quarantinePath) {
      // This is a separately created barrier, so validate its own token rather
      // than ever deleting a replacement owner that won the pathname race.
      const barrier = await readLockOwner(quarantinePath);
      if (!barrier) throw malformedLockError(name, quarantinePath);
      await durableRemoveOwned(quarantinePath, locksDir, barrier, durability);
    }
  } catch (error: unknown) {
    // A failed remove may have deleted its path before the directory durability
    // boundary. Keep (or republish) the recognized quarantine barrier instead.
    try {
      if (!await pathExists(quarantinePath)) await publishOwnedBarrier(quarantinePath, locksDir, `${lockName}.reap-unconfirmed`, owner, durability);
    } catch {
      // The original transition error remains the actionable failure; any
      // surviving source, retired path, or partially published barrier is not
      // safe for ordinary unlock to interpret as success.
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not durably acknowledge the uncertain lifecycle reap for workspace "${name}"; it remains blocked for explicit recovery: ${detail}`, { cause: error });
  }
}

/** Publish a recovery barrier which remains attributable to the dead owner. */
async function publishOwnedBarrier(path: string, locksDir: string, temporaryStem: string, owner: LockOwner, durability: StateDurabilityAdapter): Promise<void> {
  const temporaryPath = join(locksDir, `.${temporaryStem}.${randomUUID()}.pending`);
  let ownerFile: FileHandle | undefined;
  try {
    await mkdir(temporaryPath, { recursive: false, mode: 0o700 });
    ownerFile = await open(join(temporaryPath, 'owner.json'), 'wx', 0o600);
    await ownerFile.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await ownerFile.close();
    ownerFile = undefined;
    await durability.syncFile(join(temporaryPath, 'owner.json'));
    await syncDirectory(temporaryPath, durability);
    await durableRename(temporaryPath, path, locksDir, durability);
  } catch (error: unknown) {
    await ownerFile?.close();
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

function unconfirmedReapMarkerPath(lockPath: string): string {
  return join(lockPath, 'reap-unconfirmed');
}

// Published with every lifecycle lock. It makes a failed attempt to replace it
// with the more specific marker fail closed even when that replacement cannot
// be opened, flushed, or published.
function reapGuardPath(lockPath: string): string {
  return join(lockPath, 'reap-guard');
}

async function hasUnconfirmedReapBarrier(lockPath: string, quarantinePath: string): Promise<boolean> {
  return await pathExists(quarantinePath) || await pathExists(unconfirmedReapMarkerPath(lockPath));
}

async function markUnconfirmedReap(lockPath: string, durability: StateDurabilityAdapter): Promise<void> {
  const marker = unconfirmedReapMarkerPath(lockPath);
  let file: FileHandle | undefined;
  try {
    file = await open(marker, 'wx', 0o600);
    await file.close();
    file = undefined;
    await durability.syncFile(marker);
    await syncDirectory(lockPath, durability);
  } catch (error: unknown) {
    await file?.close();
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
}

async function acquireRecoveryLock(recoveryPath: string, locksDir: string, lockName: string, deadline: number, name: string, isPidAlive: (pid: number) => boolean, durability: StateDurabilityAdapter): Promise<LockOwner> {
  while (true) {
    await reclaimDeadPublishedLock(recoveryPath, isPidAlive, durability);
    const owner = await acquireOwnedDirectory(recoveryPath, locksDir, `${lockName}.recovery`, deadline, name, durability);
    if (owner) return owner;
  }
}

async function reclaimDeadPublishedLock(path: string, isPidAlive: (pid: number) => boolean, durability: StateDurabilityAdapter): Promise<void> {
  const owner = await readLockOwner(path);
  if (!owner || isPidAlive(owner.pid)) return;
  const abandonedPath = `${path}.${owner.token}.abandoned`;
  try {
    await moveOwnedLock(path, abandonedPath, owner, dirname(path), durability);
    await durableRemove(abandonedPath, dirname(path), false, durability);
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

/** Build owner metadata off-path, then atomically publish the directory. */
async function acquireOwnedDirectory(path: string, locksDir: string, temporaryStem: string, deadline: number, name: string, durability: StateDurabilityAdapter, onLockPublication?: (step: LockPublicationStep) => void | Promise<void>): Promise<LockOwner | undefined> {
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
    if (path.endsWith('.lock')) {
      const guardPath = reapGuardPath(temporaryPath);
      const guard = await open(guardPath, 'wx', 0o600);
      await guard.close();
      await durability.syncFile(guardPath);
    }
    await onLockPublication?.('owner-file-synced');
    await syncDirectory(temporaryPath, durability);
    await onLockPublication?.('staging-directory-synced');
    await durableRename(temporaryPath, path, locksDir, durability, async () => await onLockPublication?.('published'));
    await onLockPublication?.('locks-directory-synced');
    return owner;
  } catch (error: unknown) {
    await ownerFile?.close();
    await rm(temporaryPath, { recursive: true, force: true });
    // Windows reports EPERM when renaming a directory over a concurrently
    // published directory. Treat it as contention only when that destination
    // is still present; unrelated permission failures must remain visible.
    const collision = isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY') ||
      (isNodeError(error, 'EPERM') && await pathExists(path));
    if (!collision) throw error;
    // A colliding owner can retire between the failed publication and this
    // observation. Retry only when the destination is now confirmed absent;
    // a present malformed or foreign directory remains fail-closed.
    if (!await readLockOwner(path) && await pathExists(path)) throw malformedLockError(name, path, error);
    if (Date.now() >= deadline) throw lockTimeout(name, error);
    await delay();
    return undefined;
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

async function durableRename(source: string, destination: string, directory: string, durability: StateDurabilityAdapter, afterRename?: () => void | Promise<void>): Promise<void> {
  if (await durability.publicationMode() === 'recoverable') await durability.moveFileWriteThrough(source, destination);
  else await (testDurableRename ?? rename)(source, destination);
  await afterRename?.();
  await syncDirectory(directory, durability);
}

async function moveOwnedLock(source: string, destination: string, owner: LockOwner, directory: string, durability: StateDurabilityAdapter): Promise<void> {
  for (let attempts = 0; ; attempts += 1) {
    const current = await readLockOwner(source);
    if (!sameLockOwner(current, owner)) throw new Error(`Lifecycle lock owner changed before transition; refusing to move ${source}.`);
    try {
      await durableRename(source, destination, directory, durability);
      break;
    } catch (error: unknown) {
      // Windows can transiently retain a directory handle while a contender
      // observes this recovery lock. Retry only our still-owned, unique move.
      if (!isNodeError(error, 'EPERM') || attempts === 2 || await pathExists(destination) || !sameLockOwner(await readLockOwner(source), owner)) throw error;
      await delay();
    }
  }
  const moved = await readLockOwner(destination);
  if (sameLockOwner(moved, owner)) return;
  // The recovery lock prevents a compliant contender from claiming source while
  // this rollback runs. Preserve an unexpected replacement rather than delete it.
  try { await durableRename(destination, source, directory, durability); } catch { /* leave the unexpected owner intact and fail closed */ }
  throw new Error(`Lifecycle lock owner changed during transition; refusing to remove the replacement at ${source}.`);
}

async function retireOwnedLock(path: string, directory: string, owner: LockOwner | undefined, durability: StateDurabilityAdapter): Promise<void> {
  if (!owner) return;
  const retired = join(directory, `.${owner.token}.retired`);
  await moveOwnedLock(path, retired, owner, directory, durability);
  await durableRemove(retired, directory, false, durability);
}

async function durableRemove(path: string, directory: string, force: boolean, durability: StateDurabilityAdapter): Promise<void> {
  await rm(path, { recursive: true, force });
  await syncDirectory(directory, durability);
}

async function retireClearFailsafeAfterCommittedJournalClear(path: string, directory: string, durability: StateDurabilityAdapter): Promise<void> {
  // Resolve the publication capability before removing the last recovery barrier.
  const mode = await durability.publicationMode();
  await rm(path, { recursive: true, force: false });
  // Windows write-through publication does not offer a directory flush. Do not
  // convert adapter capability failures into an acknowledgement either.
  if (mode === 'recoverable') return;
  try {
    await durability.syncDirectory(directory);
  } catch {
    // The journal clear is already durable and the redundant failsafe is gone.
    // A crash may retain it, requiring a conservative later acknowledgement.
  }
}

async function durableRemoveOwned(path: string, directory: string, owner: LockOwner, durability: StateDurabilityAdapter): Promise<void> {
  if (!sameLockOwner(await readLockOwner(path), owner)) {
    throw new Error(`Lifecycle lock owner changed before removal; refusing to remove ${path}.`);
  }
  await durableRemove(path, directory, false, durability);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return false;
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

function unconfirmedReapLockError(name: string): Error {
  return new Error(`Lifecycle lock for workspace "${name}" is quarantined because local process reaping could not be confirmed and its recovery record could not be published. Ordinary unlock never clears this state. After independently verifying the local process tree and remote state are stopped, run agent-containers recover ${name} --yes --remote-command-stopped.`);
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

function sameLockOwner(left: LockOwner | undefined, right: LockOwner): boolean {
  return left?.pid === right.pid && left.token === right.token;
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
