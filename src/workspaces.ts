import { access, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentContainersConfig, ProcessResult, ProcessRunner } from './types.js';
import { validateWorkspaceName } from './names.js';
import { deleteMetadata, isAgentContainersWorkspace, loadMetadata, saveMetadata, type WorkspaceMetadata } from './state.js';

export type { ProcessRunner } from './types.js';

/** Keep enough terminal output for Dev Containers' final JSON record without unbounded memory use. */
export const PROCESS_OUTPUT_LIMIT = 1024 * 1024;

export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options = {}) {
    return new Promise((resolveResult, reject) => {
      const stdio = options.stdio ?? 'pipe';
      const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
      child.on('error', reject);
      child.on('close', (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
    });
  },
};

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
  save?: (stateDir: string, metadata: WorkspaceMetadata) => Promise<void>;
}): Promise<WorkspaceMetadata> {
  const name = validateWorkspaceName(options.name);
  if (await loadMetadata(options.stateDir, name)) throw new Error(`Agent Containers workspace "${name}" already exists.`);
  const root = await findGitRoot(options.cwd, options.runner);
  const worktree = resolve(root, options.config.workspace.worktreeRoot, name);
  try {
    await access(worktree);
    throw new Error(`Workspace path already exists: ${worktree}`);
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const branch = `agent-containers/${name}`;
  const branchResult = await options.runner.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root });
  if (branchResult.code === 0) throw new Error(`Git branch ${branch} already exists.`);
  if (branchResult.code !== 1) throw commandError('git show-ref', branchResult);
  const baseBranch = options.baseBranch ?? options.config.workspace.baseBranch;
  const relativePaths = await supportsRelativeWorktreePaths(root, options.runner);
  if (!relativePaths) throw new Error('Agent Containers requires Git support for git worktree add --relative-paths so Dev Containers can use Git inside linked worktrees.');
  const result = await options.runner.run('git', ['worktree', 'add', '--relative-paths', '-b', branch, worktree, baseBranch], { cwd: root });
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

export async function removeWorkspace(metadata: WorkspaceMetadata, options: { confirmed: boolean; skipContainerCleanup?: boolean }, runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>, removeMetadata: () => Promise<void>): Promise<void> {
  if (!options.confirmed) throw new Error('Refusing to remove a workspace without --yes.');
  if (!isAgentContainersWorkspace(metadata)) throw new Error('Refusing to remove metadata that is not an Agent Containers workspace.');
  let current = metadata;

  let worktreePresent = false;
  if (!current.cleanup?.worktree) {
    const worktrees = await runner.run('git', ['worktree', 'list', '--porcelain'], { cwd: current.repoRoot });
    if (worktrees.code !== 0) throw commandError('git worktree list', worktrees);
    const recorded = recordedWorktreeState(worktrees.stdout, current);
    if (recorded === 'mismatch') throw new Error('Refusing to remove: Git does not report the exact recorded Git worktree and branch.');
    worktreePresent = recorded === 'present';
    if (!worktreePresent) {
      try {
        await access(current.worktree);
        throw new Error(`Refusing to remove: Git no longer registers the recorded worktree, but its path still exists at ${current.worktree}. Recover or remove it manually before retrying.`);
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    }
  }

  let branchPresent = false;
  if (!current.cleanup?.branch) {
    const branch = await runner.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${current.branch}`], { cwd: current.repoRoot });
    if (branch.code === 0) branchPresent = true;
    else if (branch.code !== 1) throw commandError('git show-ref', branch);
    if (branchPresent) {
      const merged = await runner.run('git', ['merge-base', '--is-ancestor', current.branch, current.baseBranch], { cwd: current.repoRoot });
      if (merged.code === 1) throw new Error(`Refusing to remove unmerged branch ${current.branch}; merge it into ${current.baseBranch} first.`);
      if (merged.code !== 0) throw commandError('git merge-base', merged);
    }
  }

  if (current.containerId && !current.cleanup?.container && !options.skipContainerCleanup) {
    const inspect = await runner.run('docker', ['inspect', '--format', '{{ index .Config.Labels "devcontainer.local_folder" }}', current.containerId]);
    if (inspect.code !== 0) {
      if (!containerIsAlreadyGone(inspect)) throw commandError('docker inspect', inspect);
    } else if (resolve(inspect.stdout.trim()) !== current.worktree) {
      throw new Error('Refusing to remove: recorded Dev Container is not bound to the recorded worktree.');
    }
    if (inspect.code === 0) {
      const container = await runner.run('docker', ['rm', '-f', current.containerId]);
      if (container.code !== 0) throw commandError('docker rm', container);
    }
    current = withCleanup(current, 'container');
    await save(current);
  }

  if (!current.cleanup?.worktree) {
    if (worktreePresent) {
      const result = await runner.run('git', ['worktree', 'remove', current.worktree], { cwd: current.repoRoot });
      if (result.code !== 0) throw commandError('git worktree remove', result);
    }
    current = withCleanup(current, 'worktree');
    await save(current);
  }

  if (!current.cleanup?.branch) {
    if (branchPresent) {
      // merge-base above established the exact target is merged into the recorded base.
      // -D avoids Git's unrelated upstream/HEAD policy after that verification.
      const branchResult = await runner.run('git', ['branch', '-D', current.branch], { cwd: current.repoRoot });
      if (branchResult.code !== 0) throw commandError('git branch -D', branchResult);
    }
    current = withCleanup(current, 'branch');
    await save(current);
  }
  await removeMetadata();
}

export async function removeWorkspaceMetadata(stateDir: string, name: string): Promise<void> {
  await deleteMetadata(stateDir, name);
}

export async function findGitRoot(cwd: string, runner: ProcessRunner): Promise<string> {
  const result = await runner.run('git', ['rev-parse', '--show-toplevel'], { cwd });
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

async function supportsRelativeWorktreePaths(cwd: string, runner: ProcessRunner): Promise<boolean> {
  const help = await runner.run('git', ['worktree', 'add', '-h'], { cwd });
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
