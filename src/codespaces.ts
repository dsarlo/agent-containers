import type { ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import { redactSecretDiagnostic, secretShaped } from './secrets.js';

const API_VERSION = '2022-11-28';

export type CodespacesProviderProcess = Pick<ProcessRunner, 'run'>;
export interface GithubActor { id: string; login: string }
/** Legacy provider identity faade; the full readback resource is the ownership authority. */
export type CodespaceIdentity = Pick<CodespacesResource, 'id' | 'name' | 'environmentId' | 'state'>;
export interface RepositorySourceEvidence { repository: string; requestedRef: string; expectedOid: string; devcontainerPath: string; devcontainerBlobOid: string }
export interface CodespacesMachineInventory { machines: readonly { name: string; displayName: string; operatingSystem: string; storageInBytes: number; memoryInBytes: number; cpus: number; prebuildAvailability: 'none' | 'ready' | 'in_progress' | null }[] }
export interface CodespacesDefaults { billableOwner: GithubActor; location: string; devcontainerPath: string | null }
export interface RepositoryRecordIdentity { id: string; owner: string; name: string }
export interface CodespacesGitStatus { sha: string; ref: string }

/** Every field required for fail-closed Codespace ownership from the documented resource object. */
export interface CodespacesResource {
  id: string;
  name: string;
  displayName: string;
  environmentId: string;
  owner: GithubActor;
  repositoryId: string;
  repository: { owner: string; name: string };
  billingOwner: GithubActor;
  devcontainerPath: string;
  machineName: string;
  location: string;
  geo: string | null;
  createdAt: string;
  state: string;
  gitStatus: CodespacesGitStatus;
  idleTimeoutMinutes: number;
}

export interface CodespacesCreatePayload {
  repositoryId: string;
  ref: string;
  devcontainerPath: string;
  machine: string;
  idleTimeoutMinutes: number;
  retentionPeriodMinutes: number;
  geo?: string;
  displayName?: string;
}

/** Thin, replaceable adapter. It intentionally exposes no token or auth operation. */
export class GhCodespacesProvider {
  constructor(private readonly process: CodespacesProviderProcess) {}

  async actor(): Promise<GithubActor> {
    const value = await this.api('/user');
    if (!isRecord(value) || !losslessId(value.id) || !safeDisplay(value.login)) throw new Error('GitHub actor response did not contain a complete stable identity.');
    return { id: String(value.id), login: value.login };
  }

  async get(name: string): Promise<CodespacesResource> {
    if (!safeName(name)) throw new Error('Invalid Codespaces name.');
    const value = await this.api(`/user/codespaces/${encodeURIComponent(name)}`);
    if (!isRecord(value) || value.name !== name) throw new Error('GitHub response name does not equal the exact requested Codespaces name; refusing adoption.');
    return parseCodespacesResource(value, `readback of ${name}`);
  }

  /** Documented repository identity read used to bind an immutable repository ID before create. */
  async repositoryRecord(repository: string): Promise<RepositoryRecordIdentity> {
    assertRepository(repository);
    const value = await this.api(`/repos/${repository}`);
    if (!isRecord(value) || !losslessId(value.id) || !isRecord(value.owner) || !safeIdentifier(value.owner.login)) throw new Error('GitHub repository response is incomplete.');
    const [owner, name] = repository.split('/');
    if (value.owner.login !== owner || value.name !== name) throw new Error('GitHub repository identity does not equal the requested owner/repository.');
    return { id: String(value.id), owner, name };
  }

  /** Read-only candidate inventory used only for ambiguous-create diagnostics; never imported into managed state. */
  async listCandidates(repositoryId?: string): Promise<ReadonlyArray<{ id: string; name: string; state: string }>> {
    const query = repositoryId === undefined ? '' : `?repository_id=${encodeURIComponent(repositoryId)}`;
    const value = await this.api(`/user/codespaces${query}`);
    if (!isRecord(value) || typeof value.total_count !== 'number' || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || !Array.isArray(value.codespaces) || value.total_count !== value.codespaces.length) throw new Error('Codespaces candidate inventory response is incomplete.');
    return value.codespaces.map((candidate) => {
      if (!isRecord(candidate) || !losslessId(candidate.id) || !safeName(candidate.name) || !safeDisplay(candidate.state)) throw new Error('Codespaces candidate inventory contains an invalid entry.');
      return { id: String(candidate.id), name: candidate.name, state: candidate.state };
    });
  }

  /** Documented Codespaces create endpoint. Every payload field is explicitly passed as argv. */
  async create(payload: CodespacesCreatePayload): Promise<CodespacesResource> {
    if (!losslessId(payload.repositoryId) || !safeRef(payload.ref) || !safeRepositoryPath(payload.devcontainerPath) || !safeDisplay(payload.machine) || !positiveInteger(payload.idleTimeoutMinutes) || !positiveInteger(payload.retentionPeriodMinutes)) throw new Error('Codespaces create request fields are unsafe.');
    if (payload.geo !== undefined && !safeLocation(payload.geo)) throw new Error('Codespaces create geo field is unsafe.');
    if (payload.displayName !== undefined && !safeDisplay(payload.displayName)) throw new Error('Codespaces create display-name hint is unsafe.');
    const fields = [
      'repository_id', payload.repositoryId,
      'ref', payload.ref,
      'devcontainer_path', payload.devcontainerPath,
      'machine', payload.machine,
      'idle_timeout_minutes', String(payload.idleTimeoutMinutes),
      'retention_period_minutes', String(payload.retentionPeriodMinutes),
    ];
    if (payload.geo) fields.push('geo', payload.geo);
    if (payload.displayName) fields.push('display_name', payload.displayName);
    const args = ['api', '--method', 'POST', '-H', `X-GitHub-Api-Version: ${API_VERSION}`];
    for (let index = 0; index < fields.length; index += 2) args.push('-f', `${fields[index]}=${fields[index + 1] ?? ''}`);
    args.push('/user/codespaces');
    const result = await this.process.run('gh', args, { kind: 'lifecycle' });
    if (result.code !== 0) throw providerError('POST', '/user/codespaces', result);
    return parseCodespacesResource(parseJson(result.stdout, 'POST /user/codespaces'), 'create response');
  }

  /** Bounded, read-only creation/build log diagnostics for an exact recorded Codespace. */
  async creationLogs(name: string, limit: number): Promise<string> {
    if (!safeName(name) || !positiveInteger(limit)) throw new Error('Invalid creation-log selector.');
    const result = await this.process.run('gh', ['codespace', 'logs', '-c', name, '-l', String(limit)], { kind: 'readonly-probe' });
    if (result.code !== 0) throw providerError('logs', `/user/codespaces/${name}`, result);
    return result.stdout;
  }

  /**
   * Fixed, read-only, bounded SSH probe for an exact recorded Codespaces. The
   * remote argv is always package-owned; no user input is ever interpolated.
   */
  async remoteSshProbe(name: string, command: readonly [string, ...string[]], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    if (!safeName(name)) throw new Error('Invalid Codespaces name.');
    if (!command.length || command.some((value) => !value || value.includes('\0'))) throw new Error('SSH probe argv is invalid.');
    const runOptions: ProcessRunOptions = { kind: 'readonly-probe' };
    const controller = new AbortController();
    const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const result = await this.process.run('gh', ['codespace', 'ssh', '-c', name, '--', ...command], { ...runOptions, signal: controller.signal });
      if (result.code !== 0) throw providerError('ssh', name, result);
      return result.stdout;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async defaults(repository: string, ref?: string): Promise<CodespacesDefaults> {
    assertRepository(repository);
    if (ref !== undefined && !safeRef(ref)) throw new Error('Codespaces defaults selector is unsafe.');
    const query = ref === undefined ? '' : `?${new URLSearchParams({ ref })}`;
    const value = await this.api(`/repos/${repository}/codespaces/new${query}`);
    if (!isRecord(value) || !isRecord(value.billable_owner) || !losslessId(value.billable_owner.id) || !safeDisplay(value.billable_owner.login) || !isRecord(value.defaults) || !safeDisplay(value.defaults.location) || (value.defaults.devcontainer_path !== null && !safeRepositoryPath(value.defaults.devcontainer_path))) throw new Error('Codespaces defaults response is incomplete.');
    return { billableOwner: { id: String(value.billable_owner.id), login: value.billable_owner.login }, location: value.defaults.location, devcontainerPath: value.defaults.devcontainer_path };
  }

  /** GitHub's documented repository machine inventory, optionally filtered by ref/location. */
  async machines(repository: string, ref: string, location?: string): Promise<CodespacesMachineInventory> {
    assertRepository(repository);
    if (!safeRef(ref) || (location !== undefined && (secretShaped(location) || !/^[A-Za-z0-9-]{1,64}$/.test(location)))) throw new Error('Codespaces machine inventory selector is unsafe.');
    const query = new URLSearchParams({ ref });
    if (location) query.set('location', location);
    const value = await this.api(`/repos/${repository}/codespaces/machines?${query}`);
    if (!isRecord(value) || typeof value.total_count !== 'number' || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || !Array.isArray(value.machines) || value.total_count !== value.machines.length) throw new Error('Codespaces machine inventory response is incomplete.');
    const machines = value.machines.map((machine) => {
      if (!isRecord(machine) || !safeDisplay(machine.name) || !safeDisplay(machine.display_name) || !safeDisplay(machine.operating_system) || !positiveInteger(machine.storage_in_bytes) || !positiveInteger(machine.memory_in_bytes) || !positiveInteger(machine.cpus) || (machine.prebuild_availability !== null && machine.prebuild_availability !== 'none' && machine.prebuild_availability !== 'ready' && machine.prebuild_availability !== 'in_progress')) throw new Error('Codespaces machine inventory contains an invalid machine.');
      return { name: machine.name, displayName: machine.display_name, operatingSystem: machine.operating_system, storageInBytes: machine.storage_in_bytes, memoryInBytes: machine.memory_in_bytes, cpus: machine.cpus, prebuildAvailability: machine.prebuild_availability as 'none' | 'ready' | 'in_progress' | null };
    });
    return { machines };
  }

  async resolveRef(repository: string, requestedRef: string): Promise<string> {
    assertRepository(repository);
    if (!safeRef(requestedRef)) throw new Error('Requested Git ref is unsafe.');
    const value = await this.api(`/repos/${repository}/commits/${encodeURIComponent(requestedRef)}`);
    if (!isRecord(value) || !oid(value.sha)) throw new Error('Requested ref is not available to Codespaces as an immutable commit.');
    return value.sha;
  }

  async committedDevcontainerBlob(repository: string, expectedOid: string, path: string): Promise<string> {
    assertRepository(repository);
    if (!oid(expectedOid) || !safeRepositoryPath(path)) throw new Error('Dev Container path or expected commit is unsafe.');
    const value = await this.api(`/repos/${repository}/git/trees/${encodeURIComponent(expectedOid)}?recursive=1`);
    if (!isRecord(value) || !Array.isArray(value.tree)) throw new Error('Configured Dev Container path is not available from the immutable Git tree.');
    const entry = value.tree.find((candidate) => isRecord(candidate) && candidate.path === path);
    if (!isRecord(entry) || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') || !oid(entry.sha)) throw new Error('Configured Dev Container path is not a committed regular non-symlink blob at the requested immutable commit.');
    return entry.sha;
  }

  private async api(path: string): Promise<unknown> {
    if (!path.startsWith('/')) throw new Error('Provider API path must be absolute.');
    const args = ['api', '--method', 'GET', '-H', `X-GitHub-Api-Version: ${API_VERSION}`];
    args.push(path);
    const result = await this.process.run('gh', args);
    if (result.code !== 0) throw providerError('GET', path, result);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`GitHub GET ${path} returned invalid JSON; refusing to infer remote state.`); }
  }
}

export interface SafeExecuteRequest { commandId: string; argv: readonly [string, ...string[]]; cwd?: string; mode: 'pipe' | 'pty'; stdin: 'closed' | 'stream' }
export function assertSafeExecuteRequest(request: SafeExecuteRequest): void {
  if (!/^[0-9A-Za-z-]{1,128}$/.test(request.commandId)) throw new Error('commandId must be a validated durable identifier.');
  if (!request.argv.length || request.argv.some((value) => !value || value.includes('\0'))) throw new Error('Remote argv must be nonempty and must not contain NUL.');
  if (request.cwd && (!/^[^\\/][^\\]*$/.test(request.cwd) || request.cwd.split('/').some((part) => !part || part === '.' || part === '..'))) throw new Error('Remote cwd must be a safe repository-relative path.');
}

function providerError(method: string, path: string, result: ProcessResult): Error { return new Error(`GitHub ${method} ${path} failed: ${redactDiagnostic(result.stderr || result.stdout || `exit code ${result.code}`)}`); }
function redactDiagnostic(value: string): string { return redactSecretDiagnostic(value); }
function parseJson(stdout: string, context: string): unknown { try { return JSON.parse(stdout); } catch { throw new Error(`GitHub ${context} returned truncated or invalid JSON; refusing to infer remote state.`); } }

/** Parse and validate the complete documented Codespace resource without a wildcard field. */
export function parseCodespacesResource(value: unknown, context: string): CodespacesResource {
  if (!isRecord(value) || !losslessId(value.id) || !safeName(value.name) || !safeDisplay(value.display_name) || !safeDisplay(value.environment_id) ||
    !isRecord(value.owner) || !losslessId(value.owner.id) || !safeDisplay(value.owner.login) ||
    !losslessId(value.repository_id) || !isRecord(value.repository) || !safeIdentifier(value.repository.name) ||
    !isRecord(value.repository.owner) || !losslessId(value.repository.owner.id) || !safeDisplay(value.repository.owner.login) ||
    !isRecord(value.billing_owner) || !losslessId(value.billing_owner.id) || !safeDisplay(value.billing_owner.login) ||
    !safeRepositoryPath(value.devcontainer_path) || !safeDisplay(value.machine_name) || !safeDisplay(value.location) ||
    (value.geo !== null && !safeDisplay(value.geo)) || !safeDisplay(value.state) || !isTimestamp(value.created_at) ||
    !isRecord(value.git_status) || !oid(value.git_status.sha) || (value.git_status.ref !== null && !safeDisplay(value.git_status.ref)) ||
    !positiveInteger(value.idle_timeout_minutes)) {
    throw new Error(`GitHub ${context} did not contain a complete Codespaces identity; refusing adoption.`);
  }
  return {
    id: String(value.id),
    name: value.name,
    displayName: value.display_name,
    environmentId: value.environment_id,
    owner: { id: String(value.owner.id), login: value.owner.login },
    repositoryId: String(value.repository_id),
    repository: { owner: value.repository.owner.login, name: value.repository.name },
    billingOwner: { id: String(value.billing_owner.id), login: value.billing_owner.login },
    devcontainerPath: value.devcontainer_path,
    machineName: value.machine_name,
    location: value.location,
    geo: value.geo === null ? null : value.geo,
    createdAt: value.created_at,
    state: value.state,
    gitStatus: { sha: value.git_status.sha, ref: value.git_status.ref ?? '' },
    idleTimeoutMinutes: value.idle_timeout_minutes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function losslessId(value: unknown): boolean { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function safeName(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value) && !secretShaped(value); }
function oid(value: unknown): value is string { return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value); }
function safeRef(value: string): boolean { return !secretShaped(value) && /^refs\/(?:heads|tags)\/(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value) && !value.includes('..') && !value.split('/').some((part) => part.endsWith('.') || part.endsWith('.lock')); }
function safeRepositoryPath(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && !/[\0\r\n]/.test(value) && !value.startsWith('/') && !value.split('/').some((part) => !part || part === '.' || part === '..'); }
function safeDisplay(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value); }
function safeIdentifier(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
function safeLocation(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && /^[A-Za-z0-9._\- ]{1,64}$/.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function assertRepository(value: string): void { if (secretShaped(value) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid GitHub repository selector.'); }
