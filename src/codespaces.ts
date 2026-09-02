import type { ProcessResult, ProcessRunner } from './types.js';

const API_VERSION = '2022-11-28';

export type CodespacesProviderProcess = Pick<ProcessRunner, 'run'>;
export interface GithubActor { id: string; login: string }
export interface CodespaceIdentity { id: string; name: string; environmentId: string; state: string }
export interface RepositorySourceEvidence { repository: string; requestedRef: string; expectedOid: string; devcontainerPath: string; devcontainerBlobOid: string }
export interface CodespacesMachineInventory { machines: readonly { name: string; displayName: string; operatingSystem: string; storageInBytes: number; memoryInBytes: number; cpus: number; prebuildAvailability: 'none' | 'ready' | 'in_progress' | null }[] }
export interface CodespacesDefaults { billableOwner: GithubActor; location: string; devcontainerPath: string | null }

/** Thin, replaceable adapter. It intentionally exposes no token or auth operation. */
export class GhCodespacesProvider {
  constructor(private readonly process: CodespacesProviderProcess) {}

  async actor(): Promise<GithubActor> {
    const value = await this.api('/user');
    if (!isRecord(value) || !losslessId(value.id) || typeof value.login !== 'string' || !value.login) throw new Error('GitHub actor response did not contain a complete stable identity.');
    return { id: String(value.id), login: value.login };
  }

  async get(name: string): Promise<CodespaceIdentity> {
    if (!safeName(name)) throw new Error('Invalid Codespace name.');
    const value = await this.api(`/user/codespaces/${encodeURIComponent(name)}`);
    if (!isRecord(value) || !losslessId(value.id) || typeof value.name !== 'string' || typeof value.environment_id !== 'string' || typeof value.state !== 'string') throw new Error('GitHub response did not contain a complete Codespace identity; refusing adoption.');
    if (value.name !== name) throw new Error('GitHub response name does not equal the requested Codespace name; refusing adoption.');
    return { id: String(value.id), name: value.name, environmentId: value.environment_id, state: value.state };
  }

  async defaults(repository: string, ref?: string): Promise<CodespacesDefaults> {
    assertRepository(repository);
    if (ref !== undefined && !safeRef(ref)) throw new Error('Codespaces defaults selector is unsafe.');
    const query = ref === undefined ? '' : `?${new URLSearchParams({ ref })}`;
    const value = await this.api(`/repos/${repository}/codespaces/new${query}`);
    if (!isRecord(value) || !isRecord(value.billable_owner) || !losslessId(value.billable_owner.id) || typeof value.billable_owner.login !== 'string' || !value.billable_owner.login || !isRecord(value.defaults) || typeof value.defaults.location !== 'string' || !value.defaults.location || (value.defaults.devcontainer_path !== null && typeof value.defaults.devcontainer_path !== 'string')) throw new Error('Codespaces defaults response is incomplete.');
    return { billableOwner: { id: String(value.billable_owner.id), login: value.billable_owner.login }, location: value.defaults.location, devcontainerPath: value.defaults.devcontainer_path };
  }

  /** GitHub's documented repository machine inventory, optionally filtered by ref/location. */
  async machines(repository: string, ref: string, location?: string): Promise<CodespacesMachineInventory> {
    assertRepository(repository);
    if (!safeRef(ref) || (location !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(location))) throw new Error('Codespaces machine inventory selector is unsafe.');
    const query = new URLSearchParams({ ref });
    if (location) query.set('location', location);
    const value = await this.api(`/repos/${repository}/codespaces/machines?${query}`);
    if (!isRecord(value) || typeof value.total_count !== 'number' || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || !Array.isArray(value.machines) || value.total_count !== value.machines.length) throw new Error('Codespaces machine inventory response is incomplete.');
    const machines = value.machines.map((machine) => {
      if (!isRecord(machine) || typeof machine.name !== 'string' || !machine.name || typeof machine.display_name !== 'string' || !machine.display_name || typeof machine.operating_system !== 'string' || !machine.operating_system || !positiveInteger(machine.storage_in_bytes) || !positiveInteger(machine.memory_in_bytes) || !positiveInteger(machine.cpus) || (machine.prebuild_availability !== null && machine.prebuild_availability !== 'none' && machine.prebuild_availability !== 'ready' && machine.prebuild_availability !== 'in_progress')) throw new Error('Codespaces machine inventory contains an invalid machine.');
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
    const value = await this.api(`/repos/${repository}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(expectedOid)}`);
    if (!isRecord(value) || value.type !== 'file' || !oid(value.sha)) throw new Error('Configured Dev Container path is not a committed regular file at the requested immutable commit.');
    return value.sha;
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
function redactDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, '[url redacted]')
    .replace(/\b(authorization|token|password|secret)\s*[:=]\s*(?:Bearer\s+)?\S+/gi, '$1: [redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[credential redacted]')
    .slice(0, 1024);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function losslessId(value: unknown): boolean { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function safeName(value: string): boolean { return /^[A-Za-z0-9-]+$/.test(value); }
function oid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value); }
function safeRef(value: string): boolean { return value.length > 0 && value.length <= 512 && !/[\0\r\n~^:?*\x5b\\]/.test(value) && !value.includes('..') && !value.endsWith('.') && !value.startsWith('/'); }
function safeRepositoryPath(value: string): boolean { return value.length > 0 && !/[\0\r\n]/.test(value) && !value.startsWith('/') && !value.split('/').some((part) => !part || part === '.' || part === '..'); }
function assertRepository(value: string): void { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid GitHub repository selector.'); }
