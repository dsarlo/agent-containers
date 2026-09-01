import type { ProcessResult, ProcessRunner } from './types.js';

const API_VERSION = '2022-11-28';

export type CodespacesProviderProcess = Pick<ProcessRunner, 'run'>;
export interface GithubActor { id: string; login: string }
export interface CodespaceIdentity { id: string; name: string; environmentId: string; state: string }

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

  async preflight(repository: string, ref?: string): Promise<unknown> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository selector.');
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.api(`/repos/${repository}/codespaces/new${query}`);
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
  return value.slice(0, 1024)
    .replace(/https?:\/\/[^\s]+/gi, '[url redacted]')
    .replace(/\b(authorization|token|password|secret)\s*[:=]\s*(?:Bearer\s+)?\S+/gi, '$1: [redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[credential redacted]');
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function losslessId(value: unknown): boolean { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)); }
function safeName(value: string): boolean { return /^[A-Za-z0-9-]+$/.test(value); }
