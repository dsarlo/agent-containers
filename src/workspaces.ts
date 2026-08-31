import { lstat, realpath } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentContainersConfig, ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import { validateWorkspaceName } from './names.js';
import { deleteMetadata, isAgentContainersWorkspace, loadMetadata, saveMetadata, type WorkspaceMetadata } from './state.js';

export type { ProcessRunner } from './types.js';

/** Keep enough terminal output for Dev Containers' final JSON record without unbounded memory use. */
export const PROCESS_OUTPUT_LIMIT = 1024 * 1024;

export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options = {}) {
    return new Promise((resolveResult, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const stdio = options.stdio ?? 'pipe';
      const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio, detached: process.platform !== 'win32' });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let forceKill: NodeJS.Timeout | undefined;
      const cleanup = () => {
        options.signal?.removeEventListener('abort', abortChild);
        if (forceKill) clearTimeout(forceKill);
      };
      const settle = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResult(result);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abortChild = () => {
        if (settled) return;
        signalProcessTree(child, 'SIGTERM');
        forceKill = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 5_000);
      };
      child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
      child.on('error', fail);
      child.on('close', (code) => settle({ code: code ?? 1, stdout, stderr }));
      options.signal?.addEventListener('abort', abortChild, { once: true });
    });
  },
};

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32' || child.pid === undefined) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error, 'ESRCH')) throw error;
  }
}

function abortError(): Error {
  const error = new Error('Process execution was aborted.');
  error.name = 'AbortError';
  return error;
}

function withSignal(options: Omit<ProcessRunOptions, 'signal'>, signal?: AbortSignal): ProcessRunOptions {
  return signal ? { ...options, signal } : options;
}

function appendBounded(current: string, chunk: Buffer): string {
  const boundedChunk = chunk.length > PROCESS_OUTPUT_LIMIT
    ? chunk.subarray(chunk.length - PROCESS_OUTPUT_LIMIT).toString()
    : chunk.toString();
  const combined = current + boundedChunk;
  return combined.length > PROCESS_OUTPUT_LIMIT ? combined.slice(combined.length - PROCESS_OUTPUT_LIMIT) : combined;
}

export async function createWorkspace(options: {
  cwd: string;
  name: string;
  config: AgentContainersConfig;
  stateDir: string;
  runner: ProcessRunner;
  baseBranch?: string;
  signal?: AbortSignal;
  save?: (stateDir: string, metadata: WorkspaceMetadata) => Promise<void>;
}): Promise<WorkspaceMetadata> {
  const name = validateWorkspaceName(options.name);
  if (await loadMetadata(options.stateDir, name)) throw new Error(`Agent Containers workspace "${name}" already exists.`);
  const root = await findGitRoot(options.cwd, options.runner, options.signal);
  const worktree = resolve(root, options.config.workspace.worktreeRoot, name);
  try {
    await lstat(worktree);
    throw new Error(`Workspace path already exists: ${worktree}`);
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const branch = `agent-containers/${name}`;
  const branchResult = await options.runner.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], withSignal({ cwd: root }, options.signal));
  if (branchResult.code === 0) throw new Error(`Git branch ${branch} already exists.`);
  if (branchResult.code !== 1) throw commandError('git show-ref', branchResult);
  const baseBranch = options.baseBranch ?? options.config.workspace.baseBranch;
  const relativePaths = await supportsRelativeWorktreePaths(root, options.runner, options.signal);
  if (!relativePaths) throw new Error('Agent Containers requires Git support for git worktree add --relative-paths so Dev Containers can use Git inside linked worktrees.');
  const result = await options.runner.run('git', ['worktree', 'add', '--relative-paths', '-b', branch, worktree, baseBranch], withSignal({ cwd: root }, options.signal));
  if (result.code !== 0) throw commandError('git worktree add', result);
  const metadata: WorkspaceMetadata = {
    version: 1,
    name,
    repoRoot: root,
    worktree: await canonicalPath(worktree),
    branch,
    baseBranch,
    devcontainerPath: options.config.environment.devcontainerPath,
    createdAt: new Date().toISOString(),
  };
  try {
    await (options.save ?? saveMetadata)(options.stateDir, metadata);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not persist workspace metadata: ${message}. The worktree was left intact to avoid destroying untracked work; recover it with git worktree list and branch ${branch}.`, { cause: error });
  }
  return metadata;
}

export async function removeWorkspace(metadata: WorkspaceMetadata, options: { confirmed: boolean; skipContainerCleanup?: boolean; signal?: AbortSignal }, runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>, removeMetadata: () => Promise<void>): Promise<void> {
  if (!options.confirmed) throw new Error('Refusing to remove a workspace without --yes.');
  if (!isAgentContainersWorkspace(metadata)) throw new Error('Refusing to remove metadata that is not an Agent Containers workspace.');
  let current = metadata;

  let worktreePresent = false;
  if (!current.cleanup?.worktree) {
    const worktrees = await runner.run('git', ['worktree', 'list', '--porcelain'], withSignal({ cwd: current.repoRoot }, options.signal));
    if (worktrees.code !== 0) throw commandError('git worktree list', worktrees);
    const recorded = recordedWorktreeState(worktrees.stdout, current);
    if (recorded === 'mismatch') throw new Error('Refusing to remove: Git does not report the exact recorded Git worktree and branch.');
    worktreePresent = recorded === 'present';
    if (!worktreePresent) {
      try {
        await lstat(current.worktree);
        throw new Error(`Refusing to remove: Git no longer registers the recorded worktree, but its path still exists at ${current.worktree}. Recover or remove it manually before retrying.`);
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    }
  }

  let branchPresent = false;
  let branchOid: string | undefined;
  if (!current.cleanup?.branch) {
    const branch = await runner.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${current.branch}`], withSignal({ cwd: current.repoRoot }, options.signal));
    if (branch.code === 0) branchPresent = true;
    else if (branch.code !== 1) throw commandError('git show-ref', branch);
    if (branchPresent) {
      const revision = await runner.run('git', ['rev-parse', '--verify', `refs/heads/${current.branch}`], withSignal({ cwd: current.repoRoot }, options.signal));
      if (revision.code !== 0) throw commandError('git rev-parse', revision);
      branchOid = revision.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(branchOid)) throw new Error(`git rev-parse returned an invalid branch object ID for ${current.branch}.`);
      const merged = await runner.run('git', ['merge-base', '--is-ancestor', branchOid, current.baseBranch], withSignal({ cwd: current.repoRoot }, options.signal));
      if (merged.code === 1) throw new Error(`Refusing to remove unmerged branch ${current.branch}; merge it into ${current.baseBranch} first.`);
      if (merged.code !== 0) throw commandError('git merge-base', merged);
    }
  }

  if (current.containerId && !current.cleanup?.container && !options.skipContainerCleanup) {
    const inspect = await runner.run('docker', ['inspect', '--format', '{{ index .Config.Labels "devcontainer.local_folder" }}', current.containerId], withSignal({}, options.signal));
    if (inspect.code !== 0) {
      if (!containerIsAlreadyGone(inspect)) throw commandError('docker inspect', inspect);
    } else if (resolve(inspect.stdout.trim()) !== current.worktree) {
      throw new Error('Refusing to remove: recorded Dev Container is not bound to the recorded worktree.');
    }
    if (inspect.code === 0) {
      const container = await runner.run('docker', ['rm', '-f', current.containerId], withSignal({}, options.signal));
      if (container.code !== 0) throw commandError('docker rm', container);
    }
    current = withCleanup(current, 'container');
    await save(current);
  }

  if (!current.cleanup?.worktree) {
    if (worktreePresent) {
      const result = await runner.run('git', ['worktree', 'remove', current.worktree], withSignal({ cwd: current.repoRoot }, options.signal));
      if (result.code !== 0) throw commandError('git worktree remove', result);
    }
    current = withCleanup(current, 'worktree');
    await save(current);
  }

  if (!current.cleanup?.branch) {
    if (branchPresent && branchOid) {
      const branchResult = await runner.run('git', ['update-ref', '-d', `refs/heads/${current.branch}`, branchOid], withSignal({ cwd: current.repoRoot }, options.signal));
      if (branchResult.code !== 0) throw commandError('git update-ref', branchResult);
    }
    current = withCleanup(current, 'branch');
    await save(current);
  }
  await removeMetadata();
}

export async function removeWorkspaceMetadata(stateDir: string, name: string): Promise<void> {
  await deleteMetadata(stateDir, name);
}

export async function findGitRoot(cwd: string, runner: ProcessRunner, signal?: AbortSignal): Promise<string> {
  const result = await runner.run('git', ['rev-parse', '--show-toplevel'], withSignal({ cwd }, signal));
  if (result.code !== 0 || !result.stdout.trim()) throw commandError('git rev-parse --show-toplevel', result);
  return canonicalPath(resolve(result.stdout.trim()));
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function supportsRelativeWorktreePaths(cwd: string, runner: ProcessRunner, signal?: AbortSignal): Promise<boolean> {
  const help = await runner.run('git', ['worktree', 'add', '-h'], withSignal({ cwd }, signal));
  // Git 2.48+ renders this as --[no-]relative-paths; older Git renders --relative-paths.
  // Match a complete option token so prose or similarly named options cannot enable it.
  return /(?:^|\s)--(?:\[no-\])?relative-paths(?=\s|$)/m.test(`${help.stdout}\n${help.stderr}`);
}

function recordedWorktreeState(output: string, metadata: WorkspaceMetadata): 'present' | 'absent' | 'mismatch' {
  let path: string | undefined;
  let branch: string | undefined;
  let pathOrBranchMatched = false;
  const check = (): 'present' | undefined => {
    if (path === metadata.worktree || branch === `refs/heads/${metadata.branch}`) pathOrBranchMatched = true;
    return path === metadata.worktree && branch === `refs/heads/${metadata.branch}` ? 'present' : undefined;
  };
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (check() === 'present') return 'present';
      path = resolve(line.slice('worktree '.length));
      branch = undefined;
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length);
    }
  }
  if (check() === 'present') return 'present';
  return pathOrBranchMatched ? 'mismatch' : 'absent';
}

function containerIsAlreadyGone(result: ProcessResult): boolean {
  return /no such (object|container)/i.test(`${result.stdout}\n${result.stderr}`);
}

function withCleanup(metadata: WorkspaceMetadata, step: 'container' | 'worktree' | 'branch'): WorkspaceMetadata {
  return { ...metadata, cleanup: { ...metadata.cleanup, [step]: true } };
}

function commandError(command: string, result: ProcessResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`${command} failed: ${detail}`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
