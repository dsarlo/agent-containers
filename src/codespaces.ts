import type { ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import { redactSecretDiagnostic, secretShaped } from './secrets.js';

const API_VERSION = '2022-11-28';
const DEFAULT_CREATE_TIMEOUT_MS = 5 * 60 * 1000;
const CREATE_READBACK_RETRY_MS = 1_000;

export type CodespacesProviderProcess = Pick<ProcessRunner, 'run'>;
export interface GithubActor { id: string; login: string }
/** Legacy provider identity faade; the full readback resource is the ownership authority. */
export type CodespaceIdentity = Pick<CodespacesResource, 'id' | 'name' | 'environmentId' | 'state'>;
export interface RepositorySourceEvidence { repository: string; requestedRef: string; expectedOid: string; devcontainerPath: string; devcontainerBlobOid: string }
export interface CodespacesMachineInventory { machines: readonly { name: string; displayName: string; operatingSystem: string; storageInBytes: number; memoryInBytes: number; cpus: number; prebuildAvailability: 'none' | 'ready' | 'in_progress' | null }[] }
export interface CodespacesDefaults { billableOwner: GithubActor; location: string; devcontainerPath: string | null }
export interface RepositoryRecordIdentity { id: string; owner: string; name: string }
export interface CodespacesGitStatus { ref: string; sha?: string }
export interface CodespacesRemoteGitRisk { branch: string; dirty: boolean; unpushed: boolean }

/** Every field required for fail-closed Codespace ownership from the documented resource object. */
export interface CodespacesResource {
  id: string;
  name: string;
  displayName: string | null;
  environmentId: string | null;
  owner: GithubActor;
  repositoryId: string;
  repository: { owner: string; name: string };
  billingOwner: GithubActor;
  devcontainerPath: string | null;
  machineName: string | null;
  location: string;
  geo: string | null;
  createdAt: string;
  state: string;
  gitStatus: CodespacesGitStatus;
  idleTimeoutMinutes: number | null;
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

/** Minimal identity emitted by GitHub while a new Codespace is still provisioning. */
interface CodespacesCreateReceipt { id: string; name: string }

/** Thin, replaceable adapter. It intentionally exposes no token or auth operation. */
export class GhCodespacesProvider {
  constructor(
    private readonly process: CodespacesProviderProcess,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async actor(): Promise<GithubActor> {
    const value = await this.api('/user');
    if (!isRecord(value) || !losslessId(value.id) || !safeDisplay(value.login)) throw new Error('GitHub actor response did not contain a complete stable identity.');
    return { id: String(value.id), login: value.login };
  }

  async get(name: string, options: { signal?: AbortSignal } = {}): Promise<CodespacesResource> {
    if (!safeName(name)) throw new Error('Invalid Codespaces name.');
    const value = await this.api(`/user/codespaces/${encodeURIComponent(name)}`, options);
    if (!isRecord(value) || value.name !== name) throw new Error('GitHub response name does not equal the exact requested Codespaces name; refusing adoption.');
    return parseCodespacesResource(value, `readback of ${name}`);
  }

  /** Documented lifecycle PATCH, always followed by the caller's exact GET. */
  async setState(name: string, state: 'Running' | 'Shutdown'): Promise<void> {
    if (!safeName(name)) throw new Error('Invalid Codespaces name.');
    const result = await this.process.run('gh', ['api', '--method', 'PATCH', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '-f', `state=${state}`, `/user/codespaces/${encodeURIComponent(name)}`], { kind: 'lifecycle' });
    if (result.code !== 0) throw providerError('PATCH', `/user/codespaces/${name}`, result);
  }

  /** Exact-record deletion only. A 404 is deliberately left to lifecycle code
   * so it can write a tombstone rather than infer that another resource is safe. */
  async delete(name: string): Promise<void> {
    if (!safeName(name)) throw new Error('Invalid Codespaces name.');
    const result = await this.process.run('gh', ['api', '--method', 'DELETE', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, `/user/codespaces/${encodeURIComponent(name)}`], { kind: 'lifecycle' });
    if (result.code !== 0) throw providerError('DELETE', `/user/codespaces/${name}`, result);
  }

  /** Read the fixed porcelain form before a destructive lifecycle action. */
  async remoteGitRisk(name: string): Promise<CodespacesRemoteGitRisk> {
    const output = await this.remoteSshProbe(name, ['git', 'status', '--porcelain=v1', '--branch']);
    const lines = output.split(/\r?\n/).filter(Boolean);
    const header = lines.find((line) => line.startsWith('## '));
    if (!header) throw new Error('Remote Git status did not provide a branch header; deletion is blocked.');
    const branch = header.slice(3).split('...')[0]?.trim();
    if (!branch) throw new Error('Remote Git status did not provide a branch name; deletion is blocked.');
    return { branch, dirty: lines.some((line) => !line.startsWith('## ')), unpushed: /\[ahead(?: \d+)?(?:, behind \d+)?\]/.test(header) };
  }

  /** Read-only port observation through GitHub CLI's documented JSON surface. */
  async ports(name: string): Promise<ReadonlyArray<{ port: number; visibility: string }>> {
    if (!safeName(name)) throw new Error('Invalid Codespaces name.');
    const result = await this.process.run('gh', ['codespace', 'ports', '--codespace', name, '--json', 'sourcePort,visibility'], { kind: 'readonly-probe' });
    if (result.code !== 0) throw providerError('ports', name, result);
    const value = parseJson(result.stdout, `codespace ports for ${name}`);
    if (!Array.isArray(value)) throw new Error('Codespaces port observation is incomplete.');
    return value.map((entry) => {
      if (!isRecord(entry) || !positiveInteger(entry.sourcePort) || !safeDisplay(entry.visibility)) throw new Error('Codespaces port observation contains an invalid entry.');
      return { port: entry.sourcePort, visibility: entry.visibility };
    });
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
  async create(payload: CodespacesCreatePayload, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CodespacesResource> {
    if (!losslessId(payload.repositoryId) || !safeRef(payload.ref) || !safeRepositoryPath(payload.devcontainerPath) || !safeDisplay(payload.machine) || !positiveInteger(payload.idleTimeoutMinutes) || !positiveInteger(payload.retentionPeriodMinutes)) throw new Error('Codespaces create request fields are unsafe.');
    if (payload.geo !== undefined && !safeLocation(payload.geo)) throw new Error('Codespaces create geo field is unsafe.');
    if (payload.displayName !== undefined && !safeDisplay(payload.displayName)) throw new Error('Codespaces create display-name hint is unsafe.');
    const args = [
      'api', '--method', 'POST', '-H', `X-GitHub-Api-Version: ${API_VERSION}`,
      '-F', `repository_id=${payload.repositoryId}`,
      '-f', `ref=${payload.ref}`,
      '-f', `devcontainer_path=${payload.devcontainerPath}`,
      '-f', `machine=${payload.machine}`,
      '-F', `idle_timeout_minutes=${payload.idleTimeoutMinutes}`,
      '-F', `retention_period_minutes=${payload.retentionPeriodMinutes}`,
    ];
    if (payload.geo) args.push('-f', `geo=${payload.geo}`);
    if (payload.displayName) args.push('-f', `display_name=${payload.displayName}`);
    args.push('/user/codespaces');
    const controller = new AbortController();
    const relayed = options.signal;
    relayed?.addEventListener('abort', () => controller.abort(), { once: true });
    const timeoutMs = options.timeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    try {
      const result = await raceBoundedCreate(this.process.run('gh', args, { kind: 'lifecycle', signal: controller.signal }), timeoutMs, controller);
      if (result.code !== 0) throw providerError('POST', '/user/codespaces', result);
      const body = parseJson(result.stdout, 'POST /user/codespaces');
      try {
        return parseCodespacesResource(body, 'create response');
      } catch {
        const receipt = parseCodespacesCreateReceipt(body);
        return await this.readCreatedCodespace(receipt, deadline, controller);
      }
    } finally {
      controller.abort();
    }
  }

  /** Poll only exact GET readback for the receipt name until GitHub publishes full identity. */
  private async readCreatedCodespace(receipt: CodespacesCreateReceipt, deadline: number, controller: AbortController): Promise<CodespacesResource> {
    const signal = controller.signal;
    while (true) {
      if (signal.aborted) throw createDeadlineError();
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw createReadbackDeadlineError();
        const resource = await raceBoundedReadback(this.get(receipt.name, { signal }), remaining, controller);
        if (resource.id !== receipt.id) throw new Error('GitHub create readback identity does not match the exact create receipt; refusing adoption.');
        return resource;
      } catch (error: unknown) {
        if (!isProvisionalIdentityError(error)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('GitHub create receipt remained provisional past the bounded identity-readback deadline; refusing adoption.', { cause: error });
        await this.sleep(Math.min(CREATE_READBACK_RETRY_MS, remaining));
      }
    }
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
    return this.remoteCommand(name, command as readonly string[], { ...options, kind: 'readonly-probe' });
  }

  /**
   * Bounded, argv-framed `gh codespace ssh` transport for a package-owned
   * remote command. An optional binary stdin payload (for example the helper
   * copy stream) is written before the child closes; stdout is returned as the
   * bounded result. No user argv is ever concatenated into a remote shell.
   */
  async remoteCommand(name: string, command: readonly string[], options: { timeoutMs?: number; signal?: AbortSignal; input?: Uint8Array; kind?: ProcessRunOptions['kind'] } = {}): Promise<string> {
    if (!safeName(name)) throw new Error('Invalid Codespaces name.');
    if (!command.length || command.some((value) => !value || value.includes('\0'))) throw new Error('SSH argv is invalid.');
    const runOptions: ProcessRunOptions = { kind: options.kind ?? 'lifecycle' };
    if (options.input !== undefined) runOptions.binaryInput = options.input;
    const controller = new AbortController();
    const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    if (options.signal?.aborted) controller.abort();
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

  private async api(path: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (!path.startsWith('/')) throw new Error('Provider API path must be absolute.');
    const args = ['api', '--method', 'GET', '-H', `X-GitHub-Api-Version: ${API_VERSION}`];
    args.push(path);
    const result = await this.process.run('gh', args, { kind: 'readonly-probe', signal: options.signal });
    if (result.code !== 0) throw providerError('GET', path, result);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`GitHub GET ${path} returned invalid JSON; refusing to infer remote state.`); }
  }
}

export interface SafeExecuteRequest { commandId: string; argv: readonly [string, ...string[]]; cwd?: string; mode: 'pipe' | 'pty'; stdin: 'closed' | 'stream' }
export function assertSafeExecuteRequest(request: SafeExecuteRequest): void {
  if (!/^[0-9A-Za-z-]{1,128}$/.test(request.commandId)) throw new Error('commandId must be a validated durable identifier.');
  if (!request.argv.length || request.argv[0] === undefined || request.argv[0].length === 0) throw new Error('Remote argv must be nonempty and argv[0] must be nonempty.');
  if (request.argv.some((value) => typeof value !== 'string' || value.length > 1023 || value.includes('\0'))) throw new Error('Remote argv tokens must be bounded plain strings without NUL.');
  if (request.cwd && (!/^[^\\/][^\\]*$/.test(request.cwd) || request.cwd.split('/').some((part) => !part || part === '.' || part === '..'))) throw new Error('Remote cwd must be a safe repository-relative path.');
}

function providerError(method: string, path: string, result: ProcessResult): Error { return new Error(`GitHub ${method} ${path} failed: ${redactDiagnostic(result.stderr || result.stdout || `exit code ${result.code}`)}`); }
function redactDiagnostic(value: string): string { return redactSecretDiagnostic(value); }
function parseJson(stdout: string, context: string): unknown { try { return JSON.parse(stdout); } catch { throw new Error(`GitHub ${context} returned truncated or invalid JSON; refusing to infer remote state.`); } }
function parseCodespacesCreateReceipt(value: unknown): CodespacesCreateReceipt {
  if (!isRecord(value) || !losslessId(value.id) || !safeName(value.name) || typeof value.state !== 'string' || value.state.length === 0) throw new Error('GitHub create response did not contain a safe Codespaces receipt; refusing adoption.');
  return { id: String(value.id), name: value.name };
}
function isProvisionalIdentityError(error: unknown): boolean {
  return error instanceof Error && /did not contain a complete Codespaces identity; refusing adoption\.$/.test(error.message);
}

/**
 * Bound a create dispatch even when the child transport itself cannot observe
 * the deadline: the abort fires at the bound and the readback promise is
 * settled with the correct ambiguous classification. If the child completes
 * first, the timer is cleared.
 */
function raceBoundedCreate<T>(pending: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(createDeadlineError());
    }, timeoutMs);
    pending.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
function raceBoundedReadback<T>(pending: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(createReadbackDeadlineError());
    }, timeoutMs);
    pending.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
function createReadbackDeadlineError(): Error {
  return new Error('GitHub create readback exceeded its bounded deadline; the resource may exist but nothing was adopted.');
}
function createDeadlineError(): Error {
  const error = new Error('GitHub create POST exceeded its bounded deadline; the request may or may not have been dispatched and nothing was adopted.');
  error.name = 'AbortError';
  return error;
}

/** Parse and validate the complete documented Codespace resource without a wildcard field. */
export function parseCodespacesResource(value: unknown, context: string): CodespacesResource {
  if (!isRecord(value) || !losslessId(value.id) || !safeName(value.name) || !safeNullableDisplay(value.display_name) || !safeNullableDisplay(value.environment_id) ||
    !isRecord(value.owner) || !losslessId(value.owner.id) || !safeDisplay(value.owner.login) ||
    !isRecord(value.repository) || !losslessId(value.repository.id) || !safeIdentifier(value.repository.name) ||
    !isRecord(value.repository.owner) || !losslessId(value.repository.owner.id) || !safeDisplay(value.repository.owner.login) ||
    !isRecord(value.billable_owner) || !losslessId(value.billable_owner.id) || !safeDisplay(value.billable_owner.login) ||
    !safeNullableMachine(value.machine) || !safeNullableRepositoryPath(value.devcontainer_path) || !safeDisplay(value.location) ||
    !safeDisplay(value.state) || !isTimestamp(value.created_at) ||
    !isRecord(value.git_status) || (value.git_status.ref !== null && !safeDisplay(value.git_status.ref)) ||
    !nullablePositiveInteger(value.idle_timeout_minutes)) {
    throw new Error(`GitHub ${context} did not contain a complete Codespaces identity; refusing adoption.`);
  }
  return {
    id: String(value.id),
    name: value.name,
    displayName: value.display_name,
    environmentId: value.environment_id,
    owner: { id: String(value.owner.id), login: value.owner.login },
    repositoryId: String(value.repository.id),
    repository: { owner: value.repository.owner.login, name: value.repository.name },
    billingOwner: { id: String(value.billable_owner.id), login: value.billable_owner.login },
    devcontainerPath: value.devcontainer_path,
    machineName: nullableMachineName(value.machine),
    location: value.location,
    geo: null,
    createdAt: value.created_at,
    state: value.state,
    gitStatus: { ref: value.git_status.ref ?? '' },
    idleTimeoutMinutes: value.idle_timeout_minutes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function losslessId(value: unknown): boolean { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nullablePositiveInteger(value: unknown): value is number | null { return value === null || positiveInteger(value); }
function safeName(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value) && !secretShaped(value); }
function oid(value: unknown): value is string { return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value); }
function safeRef(value: string): boolean { return !secretShaped(value) && /^refs\/(?:heads|tags)\/(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value) && !value.includes('..') && !value.split('/').some((part) => part.endsWith('.') || part.endsWith('.lock')); }
function safeRepositoryPath(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && !/[\0\r\n]/.test(value) && !value.startsWith('/') && !value.split('/').some((part) => !part || part === '.' || part === '..'); }
function safeNullableRepositoryPath(value: unknown): value is string | null { return value === null || safeRepositoryPath(value); }
function safeDisplay(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value); }
function safeNullableDisplay(value: unknown): value is string | null { return value === null || safeDisplay(value); }
function safeNullableMachine(value: unknown): value is { name: string } | null { return value === null || (isRecord(value) && safeDisplay(value.name)); }
function nullableMachineName(value: unknown): string | null { return value === null ? null : (value as { name: string }).name; }
function safeIdentifier(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
function safeLocation(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && /^[A-Za-z0-9._\- ]{1,64}$/.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function assertRepository(value: string): void { if (secretShaped(value) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid GitHub repository selector.'); }
