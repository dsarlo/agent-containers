import { mkdir, lstat, readFile, rename, rm, open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getProductionStateDurabilityAdapter, type StateDurabilityAdapter } from './durability.js';
import { isValidRequestHash } from './codespaces-protocol.js';

/**
 * Local durable record for one remote command. Output bytes are never
 * persisted locally; only request metadata, status transitions, and the
 * client-acknowledged byte offsets are. These cursors describe only the live
 * connection and never permit output replay after reconnect.
 */
export type CodespacesCommandStatusState =
  | 'accepted'
  | 'starting'
  | 'running'
  | 'exited'
  | 'cancelled'
  | 'detached'
  | 'cancel-outcome-unknown'
  | 'outcome-unknown'
  | 'terminated-by-workspace-stop';

export type CodespacesCommandMode = 'pipe' | 'pty';

export interface CodespacesCommandRequest {
  schemaVersion: 1;
  commandId: string;
  requestHash: string;
  workspaceName: string;
  workspaceId: string;
  argvCount: number;
  mode: CodespacesCommandMode;
  cwd: string | null;
  createdAt: string;
}

export interface CodespacesCommandStatus {
  schemaVersion: 1;
  commandId: string;
  state: CodespacesCommandStatusState;
  exitCode: number | null;
  transport: 'connected' | 'detached';
  createdAt: string;
  startedAt: string | null;
  exitedAt: string | null;
  updatedAt: string;
}

export interface CodespacesCommandOffsets {
  schemaVersion: 1;
  commandId: string;
  stdout: string;
  stderr: string;
  terminal: string;
  updatedAt: string;
}

export interface CodespacesCommandRecovery {
  schemaVersion: 1;
  commandId: string;
  workspaceName: string;
  reason: 'transport-lost' | 'cancel-outcome-unknown';
  generation: string;
  recordedAt: string;
}

let testDurabilityAdapter: StateDurabilityAdapter | undefined;
export function setCodespacesCommandDurabilityAdapterForTesting(adapter: StateDurabilityAdapter | undefined): void {
  testDurabilityAdapter = adapter;
}
function durability(): StateDurabilityAdapter {
  return testDurabilityAdapter ?? getProductionStateDurabilityAdapter();
}

export function codespacesCommandDir(stateDir: string, commandId: string): string {
  return join(stateDir, 'codespaces', 'commands', validatedCommandId(commandId));
}
function commandRequestPath(stateDir: string, commandId: string): string {
  return join(codespacesCommandDir(stateDir, commandId), 'request.json');
}
function commandStatusPath(stateDir: string, commandId: string): string {
  return join(codespacesCommandDir(stateDir, commandId), 'status.json');
}
function commandOffsetsPath(stateDir: string, commandId: string): string {
  return join(codespacesCommandDir(stateDir, commandId), 'offsets.json');
}
function commandRecoveryPath(stateDir: string, commandId: string): string {
  return join(codespacesCommandDir(stateDir, commandId), 'recovery.json');
}

export async function recordCommandRequest(stateDir: string, request: CodespacesCommandRequest, options: { expectAbsent?: boolean } = {}): Promise<void> {
  if (!isValidCommandRequest(request)) throw new Error('Refusing to record an invalid remote command request.');
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  await ensureDurableDirectory(codespacesCommandDir(stateDir, request.commandId), adapter);
  const path = commandRequestPath(stateDir, request.commandId);
  if (options.expectAbsent) {
    try { await lstat(path); throw new Error(`Remote command ID ${request.commandId} is already recorded; refusing to overwrite an idempotent request.`); }
    catch (error: unknown) { if (!isNodeError(error, 'ENOENT')) throw error; }
  }
  await durableWrite(path, dirname(path), `${JSON.stringify(request, null, 2)}\n`, adapter);
}

export async function loadCommandRequest(stateDir: string, commandId: string): Promise<CodespacesCommandRequest | undefined> {
  try {
    const value = await readObject(commandRequestPath(stateDir, commandId));
    if (!isValidCommandRequest(value)) throw new Error(`Remote command request ${commandId} is corrupt; refusing to infer its idempotency.`);
    return value;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function saveCommandStatus(stateDir: string, status: CodespacesCommandStatus, options: { expectedState?: CodespacesCommandStatusState } = {}): Promise<void> {
  if (!isValidCommandStatus(status)) throw new Error('Refusing to save an invalid remote command status.');
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  const directory = codespacesCommandDir(stateDir, status.commandId);
  await ensureDurableDirectory(directory, adapter);
  const path = commandStatusPath(stateDir, status.commandId);
  if (options.expectedState !== undefined) {
    const current: unknown = await readObject(path);
    if (!isValidCommandStatus(current) || current.state !== options.expectedState) {
      throw new Error(`Remote command ${status.commandId} is not at expected state ${options.expectedState}; refusing a silent update.`);
    }
  }
  await durableWrite(path, dirname(path), `${JSON.stringify(status, null, 2)}\n`, adapter);
}

export async function loadCommandStatus(stateDir: string, commandId: string): Promise<CodespacesCommandStatus | undefined> {
  try {
    const value = await readObject(commandStatusPath(stateDir, commandId));
    if (!isValidCommandStatus(value)) throw new Error(`Remote command status ${commandId} is corrupt; refusing to infer its outcome.`);
    return value;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function saveCommandOffsets(stateDir: string, offsets: CodespacesCommandOffsets): Promise<void> {
  if (!isValidCommandOffsets(offsets)) throw new Error('Refusing to save invalid remote command offsets.');
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  const directory = codespacesCommandDir(stateDir, offsets.commandId);
  await ensureDurableDirectory(directory, adapter);
  await durableWrite(commandOffsetsPath(stateDir, offsets.commandId), dirname(directory), `${JSON.stringify(offsets, null, 2)}\n`, adapter);
}

export async function loadCommandOffsets(stateDir: string, commandId: string): Promise<CodespacesCommandOffsets | undefined> {
  try {
    const value = await readObject(commandOffsetsPath(stateDir, commandId));
    if (!isValidCommandOffsets(value)) throw new Error(`Remote command offsets ${commandId} are corrupt; refusing to resume from corrupted cursors.`);
    return value;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export type CommandIdempotency = 'created' | 'attach';

/** Bind commandId + requestHash. Replaying the same pair attaches; reusing the ID with a different hash fails. */
export async function resolveCommandIdempotency(stateDir: string, commandId: string, requestHash: string): Promise<CommandIdempotency> {
  const request = await loadCommandRequest(stateDir, commandId);
  if (!request) return 'created';
  if (request.requestHash !== requestHash) {
    throw new Error(`Remote command ID ${commandId} was requested with a different argv hash; reusing an ID for a new argv is refused.`);
  }
  return 'attach';
}

export async function recordCommandRecovery(stateDir: string, input: { commandId: string; workspaceName: string; reason: 'transport-lost' | 'cancel-outcome-unknown'; recordedAt?: string; generation?: string }): Promise<CodespacesCommandRecovery> {
  const recovery: CodespacesCommandRecovery = {
    schemaVersion: 1,
    commandId: input.commandId,
    workspaceName: input.workspaceName,
    reason: input.reason,
    generation: input.generation ?? randomUUID(),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
  if (!isValidCommandRecovery(recovery)) throw new Error('Refusing to record invalid remote command recovery.');
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  const directory = codespacesCommandDir(stateDir, recovery.commandId);
  await ensureDurableDirectory(directory, adapter);
  await durableWrite(commandRecoveryPath(stateDir, recovery.commandId), dirname(directory), `${JSON.stringify(recovery, null, 2)}\n`, adapter);
  return recovery;
}

export async function loadCommandRecovery(stateDir: string, commandId: string): Promise<CodespacesCommandRecovery | undefined> {
  try {
    const value = await readObject(commandRecoveryPath(stateDir, commandId));
    if (!isValidCommandRecovery(value)) throw new Error(`Remote command recovery ${commandId} is corrupt; refusing to clear it.`);
    return value;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function clearCommandRecovery(stateDir: string, commandId: string, expectedGeneration: string): Promise<void> {
  const current = await loadCommandRecovery(stateDir, commandId);
  if (!current) throw new Error(`No remote command recovery barrier exists for ${commandId}.`);
  if (current.generation !== expectedGeneration) throw new Error(`Remote command recovery for ${commandId} changed since it was acknowledged; refusing to clear the newer barrier.`);
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  await rm(commandRecoveryPath(stateDir, commandId), { force: false });
  await adapter.syncDirectory(dirname(commandRecoveryPath(stateDir, commandId)));
}

export function commandRecoveryDigest(recovery: CodespacesCommandRecovery): string {
  return createHash('sha256').update(JSON.stringify(recovery)).digest('hex');
}

function isValidCommandRequest(value: unknown): value is CodespacesCommandRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<CodespacesCommandRequest>;
  return request.schemaVersion === 1 && isValidCommandId(request.commandId) && isValidRequestHash(request.requestHash ?? '')
    && typeof request.workspaceName === 'string' && isValidCommandId(request.workspaceId)
    && typeof request.argvCount === 'number' && Number.isSafeInteger(request.argvCount) && request.argvCount > 0
    && (request.mode === 'pipe' || request.mode === 'pty')
    && (request.cwd === null || (typeof request.cwd === 'string' && request.cwd.length > 0 && !/[\0\r\n]/.test(request.cwd)))
    && isTimestamp(request.createdAt);
}

function isValidCommandStatus(value: unknown): value is CodespacesCommandStatus {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Partial<CodespacesCommandStatus>;
  return status.schemaVersion === 1 && isValidCommandId(status.commandId) && isStatusState(status.state)
    && (status.exitCode === null || (typeof status.exitCode === 'number' && Number.isInteger(status.exitCode) && status.exitCode >= 0 && status.exitCode <= 255))
    && (status.transport === 'connected' || status.transport === 'detached')
    && isTimestamp(status.createdAt) && (status.startedAt === null || isTimestamp(status.startedAt))
    && (status.exitedAt === null || isTimestamp(status.exitedAt)) && isTimestamp(status.updatedAt);
}

function isValidCommandOffsets(value: unknown): value is CodespacesCommandOffsets {
  if (typeof value !== 'object' || value === null) return false;
  const offsets = value as Partial<CodespacesCommandOffsets>;
  return offsets.schemaVersion === 1 && isValidCommandId(offsets.commandId) && isOffsetString(offsets.stdout)
    && isOffsetString(offsets.stderr) && isOffsetString(offsets.terminal) && isTimestamp(offsets.updatedAt);
}

function isValidCommandRecovery(value: unknown): value is CodespacesCommandRecovery {
  if (typeof value !== 'object' || value === null) return false;
  const recovery = value as Partial<CodespacesCommandRecovery>;
  return recovery.schemaVersion === 1 && isValidCommandId(recovery.commandId) && typeof recovery.workspaceName === 'string'
    && (recovery.reason === 'transport-lost' || recovery.reason === 'cancel-outcome-unknown')
    && isUuid(recovery.generation) && isTimestamp(recovery.recordedAt);
}

function isStatusState(value: unknown): value is CodespacesCommandStatusState {
  return typeof value === 'string' && ['accepted', 'starting', 'running', 'exited', 'cancelled', 'detached', 'cancel-outcome-unknown', 'outcome-unknown', 'terminated-by-workspace-stop'].includes(value);
}

function isOffsetString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && BigInt(value) >= 0n;
}

export function validatedCommandId(commandId: string): string {
  if (!isValidCommandId(commandId)) throw new Error('commandId must be a validated durable identifier.');
  return commandId;
}
function isValidCommandId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z-]{1,128}$/.test(value);
}
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }

async function ensureDurableDirectory(directory: string, adapter: StateDurabilityAdapter): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    let entry;
    try { entry = await lstat(current); }
    catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Unable to find a parent for durable directory: ${directory}`, { cause: error });
      missing.push(current);
      current = parent;
      continue;
    }
    if (!entry.isDirectory()) throw new Error(`Durable directory path is not a directory: ${current}`);
    break;
  }
  for (const created of missing.reverse()) {
    await mkdir(created, { recursive: false, mode: 0o700 });
    await adapter.syncDirectory(created);
    await adapter.syncDirectory(dirname(created));
  }
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  let error: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (caught: unknown) {
      const code = (caught as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw caught;
      error = caught;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  throw error;
}

async function durableWrite(path: string, directory: string, content: string, adapter: StateDurabilityAdapter): Promise<void> {
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.close();
    file = undefined;
    await adapter.syncFile(temporary);
    if (await adapter.publicationMode() === 'recoverable') await adapter.moveFileWriteThrough(temporary, path);
    else { await renameWithRetry(temporary, path); await adapter.syncDirectory(directory); }
  } catch (error: unknown) {
    await file?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readObject(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) throw error;
    throw new Error(`Durable record ${path} is not valid JSON; refusing to infer state.`, { cause: error });
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
