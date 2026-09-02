import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getProductionStateDurabilityAdapter, type StateDurabilityAdapter } from './durability.js';
import { isValidWorkspaceName } from './names.js';
import { secretShaped } from './secrets.js';
import type { CodespacesResource } from './codespaces.js';

export type CodespacesOperationState =
  | 'intent-recorded'
  | 'create-dispatched'
  | 'resource-recorded'
  | 'identity-verified'
  | 'identity-mismatch'
  | 'revision-mismatch'
  | 'provider-error'
  | 'ambiguous-create'
  | 'recovery-required'
  | 'recovery-cleared';

export type CodespacesRecoveryReason =
  | 'provider-timeout-before-dispatch'
  | 'provider-timeout-after-creation-possible'
  | 'create-response-truncated-or-invalid'
  | 'duplicate-request-id'
  | 'moved-ref'
  | 'actor-changed'
  | 'identity-mismatch'
  | 'revision-mismatch'
  | 'billing-policy-machine-rejected'
  | 'state-write-failed-after-dispatch'
  | 'corrupt-record';

export interface CodespacesCreateRecoveryContext {
  reason: CodespacesRecoveryReason | null;
  recordedAt: string | null;
  observedRemoteState: string | null;
}

/** Durable create intent/operation record. Persisted before any provider side effect. */
export interface CodespacesCreateIntent {
  schemaVersion: 1;
  requestId: string;
  name: string;
  createdAt: string;
  control: { githubHost: string; actorId: string; actorLogin: string; ghVersion: string };
  repository: { id: string; owner: string; name: string };
  source: { requestedRef: string; expectedOid: string; devcontainerPath: string; devcontainerBlobOid: string };
  capacity: { machine: string; geo: string | null; idleTimeoutMinutes: number; retentionPeriodMinutes: number; displayNameHint: string | null };
  state: CodespacesOperationState;
  providerCorrelationId: string | null;
  providerError: string | null;
  /** The exact provider identity response, persisted once a create response is recorded. */
  providerResource: CodespacesResource | null;
  updatedAt: string;
  recoveryContext: CodespacesCreateRecoveryContext | null;
}

export type CodespacesJournalKind =
  | 'operation-created'
  | 'provider-request-dispatched'
  | 'provider-response-recorded'
  | 'identity-verified'
  | 'identity-mismatch'
  | 'readiness-transition'
  | 'recovery-set'
  | 'recovery-cleared'
  | 'ambiguous-create'
  | 'provider-error';

export interface CodespacesJournalEvent {
  schemaVersion: 1;
  event: CodespacesJournalKind;
  eventId: string;
  workspaceName: string;
  operationId: string;
  requestId: string | null;
  actorId: string | null;
  repositoryId: string | null;
  codespaceId: string | null;
  previous: string | null;
  next: string | null;
  occurredAt: string;
  /** Nonsecret, bounded diagnostic already redacted by the caller. */
  detail: string | null;
}

export type CodespacesJournalEventInput = Omit<CodespacesJournalEvent, 'schemaVersion' | 'eventId' | 'occurredAt'>;

interface CheckedCodespacesJournalEvent extends CodespacesJournalEvent {
  checksum: string;
}

export interface CodespacesIntentSummary { requestId: string; name: string; state: CodespacesOperationState; createdAt: string; expectedOid: string }

let testDurabilityAdapter: StateDurabilityAdapter | undefined;
export function setCodespacesOpsDurabilityAdapterForTesting(adapter: StateDurabilityAdapter | undefined): void {
  testDurabilityAdapter = adapter;
}
function durability(): StateDurabilityAdapter {
  return testDurabilityAdapter ?? getProductionStateDurabilityAdapter();
}

export function codespacesOpsDir(stateDir: string): string {
  return join(stateDir, 'codespaces', 'ops');
}
export function codespacesJournalDir(stateDir: string): string {
  return join(stateDir, 'codespaces', 'events');
}
export function codespacesCapacityLockDir(stateDir: string): string {
  return join(stateDir, 'codespaces', 'capacity');
}
export function intentPath(stateDir: string, requestId: string): string {
  return join(codespacesOpsDir(stateDir), validatedRequestId(requestId), '..', `${validatedRequestId(requestId)}.json`);
}
function journalPath(stateDir: string, name: string): string {
  return join(codespacesJournalDir(stateDir), `${validatedWorkspaceName(name)}.journal`);
}

export async function recordCreateIntent(stateDir: string, intent: CodespacesCreateIntent, options: { expectAbsent?: boolean } = {}): Promise<void> {
  if (!isValidIntent(intent)) throw new Error('Refusing to record an invalid Codespaces create intent.');
  return withOpsPublication(stateDir, codespacesOpsDir(stateDir), `${intent.requestId}.json`, intent, options);
}

export async function updateCreateIntent(stateDir: string, intent: CodespacesCreateIntent, options: { expectedState?: CodespacesOperationState } = {}): Promise<void> {
  if (!isValidIntent(intent)) throw new Error('Refusing to record an invalid Codespaces create intent.');
  return withOpsPublication(stateDir, codespacesOpsDir(stateDir), `${intent.requestId}.json`, intent, {}, options);
}

async function withOpsPublication(stateDir: string, directory: string, relativePath: string, intent: CodespacesCreateIntent, createOptions: { expectAbsent?: boolean }, updateOptions: { expectedState?: CodespacesOperationState } = {}): Promise<void> {
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  await ensureDurableDirectory(directory, adapter);
  const path = join(directory, relativePath);
  if (createOptions.expectAbsent) {
    try { await lstat(path); throw new Error(`Codespaces create request ID ${intent.requestId} is a duplicate local request ID; refusing to overwrite the recorded operation.`); }
    catch (error: unknown) { if (!isNodeError(error, 'ENOENT')) throw error; }
  } else if (updateOptions.expectedState !== undefined) {
    const current: unknown = await readObject(path);
    if (!isValidIntent(current) || current.state !== updateOptions.expectedState) {
      throw new Error(`Codespaces create request ${intent.requestId} is not at expected state ${updateOptions.expectedState}; refusing a silent update.`);
    }
  }
  await durableWrite(path, directory, JSON.stringify(intent, null, 2), adapter);
}

export async function loadCreateIntent(stateDir: string, requestId: string): Promise<CodespacesCreateIntent | undefined> {
  try {
    const value: unknown = await readObject(intentPath(stateDir, requestId));
    if (!isValidIntent(value)) throw new Error(`Codespaces create intent ${requestId} is corrupt; recovery must inspect it manually.`);
    return value;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** Read-only inventory used for capacity accounting and ambiguous-create diagnostics. */
export async function listCreateIntents(stateDir: string): Promise<CodespacesIntentSummary[]> {
  let files: string[];
  try { files = await readdir(codespacesOpsDir(stateDir)); }
  catch (error: unknown) { if (isNodeError(error, 'ENOENT')) return []; throw error; }
  const summaries: CodespacesIntentSummary[] = [];
  for (const file of files.filter((entry) => entry.endsWith('.json')).sort()) {
    const intent = await loadCreateIntent(stateDir, file.slice(0, -5));
    if (intent) summaries.push({ requestId: intent.requestId, name: intent.name, state: intent.state, createdAt: intent.createdAt, expectedOid: intent.source.expectedOid });
  }
  return summaries;
}

export async function recordCodespacesEvent(stateDir: string, input: CodespacesJournalEventInput): Promise<void> {
  const event: CodespacesJournalEvent = { schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(), ...input };
  validateEvent(event);
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  await ensureDurableDirectory(codespacesJournalDir(stateDir), adapter);
  const path = journalPath(stateDir, event.workspaceName);
  const source = await readFile(path, 'utf8').catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return '';
    throw error;
  });
  const committed = source.endsWith('\n') ? source : source.slice(0, source.lastIndexOf('\n') + 1);
  const entry: CheckedCodespacesJournalEvent = { ...event, checksum: journalChecksum(event) };
  await durableWrite(path, dirname(path), `${committed}${JSON.stringify(entry)}\n`, adapter);
}

export async function loadCodespacesJournal(stateDir: string, name: string): Promise<CodespacesJournalEvent[]> {
  try {
    const source = await readFile(journalPath(stateDir, name), 'utf8');
    return parseJournal(source, name);
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

function parseJournal(source: string, name: string): CodespacesJournalEvent[] {
  const lines = source.split('\n');
  const hasPartialTail = source.length > 0 && !source.endsWith('\n');
  if (hasPartialTail) lines.pop();
  const events: CodespacesJournalEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch {
      throw new Error(`Codespaces operation journal for ${name} is corrupt before its final record; refusing to treat remote state as known.`);
    }
    if (!isCheckedEvent(entry)) {
      throw new Error(`Codespaces operation journal for ${name} is corrupt before its final record; refusing to treat remote state as known.`);
    }
    events.push(entry);
  }
  return events;
}

function isCheckedEvent(value: unknown): value is CodespacesJournalEvent {
  if (typeof value !== 'object' || value === null || !('event' in value) || !('checksum' in value) || typeof value.checksum !== 'string') return false;
  if (!isJournalKind(value.event)) return false;
  const { checksum, ...rest } = value as Record<string, unknown>;
  try { validateEvent(rest as unknown as CodespacesJournalEvent); } catch { return false; }
  return checksum === journalChecksum(rest as unknown as CodespacesJournalEvent);
}

function journalChecksum(event: CodespacesJournalEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function validateEvent(event: CodespacesJournalEvent): void {
  if (event.schemaVersion !== 1 || !isJournalKind(event.event) || !isUuid(event.eventId) || !isValidWorkspaceName(event.workspaceName)
    || !isUuid(event.operationId) || (event.requestId !== null && !isUuid(event.requestId))
    || (event.actorId !== null && !losslessId(event.actorId)) || (event.repositoryId !== null && !losslessId(event.repositoryId))
    || (event.codespaceId !== null && !losslessId(event.codespaceId))
    || (event.previous !== null && !safeDetail(event.previous)) || (event.next !== null && !safeDetail(event.next))
    || !isTimestamp(event.occurredAt)) throw new Error('Codespaces journal event fields are invalid.');
  if (event.detail !== null && !safeDetail(event.detail)) throw new Error('Codespaces journal detail must be nonsecret and bounded.');
}

function isValidIntent(value: unknown): value is CodespacesCreateIntent {
  if (typeof value !== 'object' || value === null) return false;
  const intent = value as Partial<CodespacesCreateIntent>;
  if (intent.schemaVersion !== 1 || !isUuid(intent.requestId) || !(typeof intent.name === 'string' && isValidWorkspaceName(intent.name)) || !isTimestamp(intent.createdAt) || !isTimestamp(intent.updatedAt)) return false;
  if (!isOperationState(intent.state)) return false;
  const { control, repository, source, capacity } = intent;
  if (typeof control !== 'object' || control === null || control.githubHost !== 'github.com' || !losslessId(control.actorId) || !safeDisplay(control.actorLogin) || !safeDisplay(control.ghVersion)) return false;
  if (typeof repository !== 'object' || repository === null || !losslessId(repository.id) || !safeIdentifier(repository.owner) || !safeIdentifier(repository.name)) return false;
  if (typeof source !== 'object' || source === null || !safeRef(source.requestedRef) || !oid(source.expectedOid) || !safeRepositoryPath(source.devcontainerPath) || !oid(source.devcontainerBlobOid)) return false;
  if (typeof capacity !== 'object' || capacity === null || !safeDisplay(capacity.machine) || (capacity.geo !== null && !safeDisplayGeo(capacity.geo)) || !positiveInteger(capacity.idleTimeoutMinutes) || !positiveInteger(capacity.retentionPeriodMinutes) || (capacity.displayNameHint !== null && !safeDisplay(capacity.displayNameHint))) return false;
  if (intent.providerCorrelationId !== null && !safeDisplay(intent.providerCorrelationId)) return false;
  if (intent.providerError !== null && !safeDetail(intent.providerError)) return false;
  if (intent.recoveryContext !== null && (typeof intent.recoveryContext !== 'object' || (intent.recoveryContext.reason !== null && !safeDetail(intent.recoveryContext.reason)) || (intent.recoveryContext.recordedAt !== null && !isTimestamp(intent.recoveryContext.recordedAt)) || (intent.recoveryContext.observedRemoteState !== null && !safeDetail(intent.recoveryContext.observedRemoteState)))) return false;
  return true;
}

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
    await syncDirectory(created, adapter);
    await syncDirectory(dirname(created), adapter);
  }
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
    else { await rename(temporary, path); await syncDirectory(directory, adapter); }
  } catch (error: unknown) {
    await file?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(directory: string, adapter: StateDurabilityAdapter): Promise<void> {
  if (await adapter.publicationMode() === 'recoverable') return;
  await adapter.syncDirectory(directory);
}

async function readObject(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) throw error;
    throw new Error(`Durable record ${path} is not valid JSON; refusing to infer state.`, { cause: error });
  }
}

function validatedRequestId(requestId: string): string {
  if (!isUuid(requestId)) throw new Error('Codespaces create request ID must be a validated UUID.');
  return requestId;
}
function validatedWorkspaceName(name: string): string {
  if (!isValidWorkspaceName(name)) throw new Error('Workspace name is invalid.');
  return name;
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function losslessId(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]*$/.test(value); }
function oid(value: unknown): value is string { return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function safeIdentifier(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
function safeDisplay(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value); }
function safeDisplayGeo(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && /^[A-Za-z0-9._\- ]{1,64}$/.test(value); }
function safeRepositoryPath(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && !/[\0\r\n\\]/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..'); }
function safeDetail(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && value.length <= 2048 && !/[\0\r\n]/.test(value); }
function safeRef(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && /^refs\/(?:heads|tags)\/(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value) && !value.includes('..') && !value.split('/').some((part) => part.endsWith('.') || part.endsWith('.lock')); }
function isOperationState(value: unknown): value is CodespacesOperationState { return typeof value === 'string' && ['intent-recorded', 'create-dispatched', 'resource-recorded', 'identity-verified', 'identity-mismatch', 'revision-mismatch', 'provider-error', 'ambiguous-create', 'recovery-required', 'recovery-cleared'].includes(value); }
function isJournalKind(value: unknown): value is CodespacesJournalKind { return typeof value === 'string' && ['operation-created', 'provider-request-dispatched', 'provider-response-recorded', 'identity-verified', 'identity-mismatch', 'readiness-transition', 'recovery-set', 'recovery-cleared', 'ambiguous-create', 'provider-error'].includes(value); }
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }