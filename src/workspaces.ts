import { lstat, realpath } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentContainersConfig, ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import { validateWorkspaceName } from './names.js';
import { bootstrapManualRecoveryJournal, deleteMetadata, isAgentContainersWorkspace, loadMetadata, saveMetadata, type WorkspaceMetadata } from './state.js';

export type { ProcessRunner } from './types.js';

/** Keep enough terminal output for Dev Containers' final JSON record without unbounded memory use. */
export const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_OUTPUT_EVENT_LIMIT = 64 * 1024;
const WINDOWS_REAP_TIMEOUT_MS = 5_000;

export interface NodeProcessRunnerDependencies {
  /** Override only for focused cross-platform process-runner tests. */
  platform?: NodeJS.Platform;
  /** Override only for focused cross-platform process-runner tests. */
  spawn?: typeof spawn;
  /** Bound Windows cancellation reaping without making focused tests wait seconds. */
  windowsReapTimeoutMs?: number;
}

export function createNodeProcessRunner({
  platform = process.platform,
  spawn: spawnProcess = spawn,
  windowsReapTimeoutMs = WINDOWS_REAP_TIMEOUT_MS,
}: NodeProcessRunnerDependencies = {}): ProcessRunner {
  return {
    run(command, args, options = {}) {
      return new Promise((resolveResult, reject) => {
        if (options.signal?.aborted) {
          reject(abortError());
          return;
        }
        const stdio = options.stdio ?? 'pipe';
        const child = spawnProcess(command, args, { cwd: options.cwd, shell: false, stdio, detached: platform !== 'win32' });
        if (options.input !== undefined) child.stdin?.end(options.input);
        let stdout = '';
        let stderr = '';
        const stdoutDecoder = new TextDecoder();
        const stderrDecoder = new TextDecoder();
        let settled = false;
        let forceKill: NodeJS.Timeout | undefined;
        let rootTerminationAttempted = false;
        const terminateRootOnce = () => {
          if (rootTerminationAttempted) return;
          rootTerminationAttempted = true;
          terminateManagedRoot(child);
        };
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
          if (platform === 'win32') {
            signalProcessTree(child, 'SIGTERM', platform, spawnProcess, terminateRootOnce);
            forceKill = setTimeout(() => {
              try {
                // This is a failed recovery, not proof that taskkill stopped descendants.
                terminateRootOnce();
                fail(windowsReapTimeoutError());
              } catch (error: unknown) {
                fail(error instanceof Error ? error : new Error(String(error)));
              }
            }, windowsReapTimeoutMs);
            return;
          }
          signalProcessTree(child, 'SIGTERM', platform, spawnProcess);
          forceKill = setTimeout(() => signalProcessTree(child, 'SIGKILL', platform, spawnProcess), 5_000);
        };
        const receive = (stream: 'stdout' | 'stderr', chunk: Buffer, flush = false) => {
          const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).decode(chunk, { stream: !flush });
          if (!text) return;
          if (stream === 'stdout') stdout = appendBounded(stdout, text);
          else stderr = appendBounded(stderr, text);
          for (let start = 0; start < text.length; start += PROCESS_OUTPUT_EVENT_LIMIT) {
            options.onOutput?.({ stream, text: text.slice(start, start + PROCESS_OUTPUT_EVENT_LIMIT) });
          }
        };
        child.stdout?.on('data', (chunk: Buffer) => { receive('stdout', chunk); });
        child.stderr?.on('data', (chunk: Buffer) => { receive('stderr', chunk); });
        child.on('error', fail);
        child.on('close', (code) => {
          receive('stdout', Buffer.alloc(0), true);
          receive('stderr', Buffer.alloc(0), true);
          settle({ code: code ?? 1, stdout, stderr });
        });
        options.signal?.addEventListener('abort', abortChild, { once: true });
      });
    },
  };
}

export const nodeProcessRunner: ProcessRunner = createNodeProcessRunner();

function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
  terminateWindowsRoot?: () => void,
): void {
  try {
    if (platform === 'win32') {
      if (child.pid === undefined) return;
      // taskkill follows the Windows process tree without invoking a command shell.
      const killer = spawnProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
      // A child may exit after cancellation is requested; taskkill then reports it
      // asynchronously. That is not a runner failure and must not escape the event loop.
      let rootTerminationAttempted = false;
      const terminateRootOnce = () => {
        if (rootTerminationAttempted) return;
        rootTerminationAttempted = true;
        (terminateWindowsRoot ?? (() => terminateManagedRoot(child)))();
      };
      killer.once('error', terminateRootOnce);
      // Do not retry tree termination: on failure, make one best-effort direct attempt
      // on the managed root only. This does not imply its descendants are stopped.
      killer.once('close', (code) => {
        if (code !== 0) terminateRootOnce();
      });
      return;
    }
    if (child.pid === undefined) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error, 'ESRCH')) throw error;
  }
}

function windowsReapTimeoutError(): Error {
  return new Error('Windows process reaping timed out before the managed child closed; cancellation recovery requires manual verification.');
}

function terminateManagedRoot(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch (error: unknown) {
    // An exited root is a normal cancellation race. The runner still waits for close.
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

function appendBounded(current: string, text: string): string {
  const combined = current + text;
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
  // A new workspace may establish its recovery journal before any Git side effect.
  await bootstrapManualRecoveryJournal(options.stateDir, name);
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
  const baseRef = localBaseRef(options.baseBranch ?? options.config.workspace.baseBranch);
  const base = await options.runner.run('git', ['show-ref', '--verify', '--quiet', baseRef], withSignal({ cwd: root }, options.signal));
  if (base.code === 1) throw new Error(`Base must name an existing local branch under refs/heads/: ${baseRef}.`);
  if (base.code !== 0) throw commandError('git show-ref', base);
  const relativePaths = await supportsRelativeWorktreePaths(root, options.runner, options.signal);
  if (!relativePaths) throw new Error('Agent Containers requires Git support for git worktree add --relative-paths so Dev Containers can use Git inside linked worktrees.');
  let result: ProcessResult;
  try {
    result = await options.runner.run('git', ['worktree', 'add', '--relative-paths', '-b', branch, worktree, baseRef], withSignal({ cwd: root }, options.signal));
  } catch (error: unknown) {
    throw await worktreeAddRecoveryError(error, root, worktree, branch, options.runner);
  }
  if (result.code !== 0) throw await worktreeAddRecoveryError(commandError('git worktree add', result), root, worktree, branch, options.runner);
  const metadata: WorkspaceMetadata = {
    version: 1,
    name,
    repoRoot: root,
    worktree: await canonicalPath(worktree),
    branch,
    baseRef,
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

export interface RemoveWorkspaceOptions {
  confirmed: boolean;
  /** Explicitly allow Git to remove a dirty or untracked owned worktree. */
  forceWorktree?: boolean;
  skipContainerCleanup?: boolean;
  signal?: AbortSignal;
}

export async function removeWorkspace(metadata: WorkspaceMetadata, options: RemoveWorkspaceOptions, runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>, removeMetadata: () => Promise<void>): Promise<void> {
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
  let baseOid: string | undefined;
  const baseRef = current.baseRef;
  if (!current.cleanup?.branch) {
    const branch = await runner.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${current.branch}`], withSignal({ cwd: current.repoRoot }, options.signal));
    if (branch.code === 0) branchPresent = true;
    else if (branch.code !== 1) throw commandError('git show-ref', branch);
    if (branchPresent) {
      const revision = await runner.run('git', ['rev-parse', '--verify', `refs/heads/${current.branch}`], withSignal({ cwd: current.repoRoot }, options.signal));
      if (revision.code !== 0) throw commandError('git rev-parse', revision);
      branchOid = revision.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(branchOid)) throw new Error(`git rev-parse returned an invalid branch object ID for ${current.branch}.`);
      const baseRevision = await runner.run('git', ['rev-parse', '--verify', baseRef], withSignal({ cwd: current.repoRoot }, options.signal));
      if (baseRevision.code !== 0) throw commandError('git rev-parse', baseRevision);
      baseOid = baseRevision.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(baseOid)) throw new Error(`git rev-parse returned an invalid base object ID for ${baseRef}.`);
      const merged = await runner.run('git', ['merge-base', '--is-ancestor', branchOid, baseOid], withSignal({ cwd: current.repoRoot }, options.signal));
      if (merged.code === 1) throw new Error(`Refusing to remove unmerged branch ${current.branch}; merge it into ${baseRef} first.`);
      if (merged.code !== 0) throw commandError('git merge-base', merged);
    }
  }

  if (worktreePresent && !current.cleanup?.worktree && !options.forceWorktree) {
    const status = await runner.run('git', ['status', '--porcelain=v1', '--untracked-files=all'], withSignal({ cwd: current.worktree }, options.signal));
    if (status.code !== 0) throw commandError('git status', status);
    if (status.stdout.trim()) {
      throw new Error(`Refusing to remove dirty or untracked worktree ${current.worktree}. After reviewing its files, retry with ac remove ${current.name} --yes --force-worktree.`);
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
      const result = await runner.run('git', ['worktree', 'remove', ...(options.forceWorktree ? ['--force'] : []), current.worktree], withSignal({ cwd: current.repoRoot }, options.signal));
      if (result.code !== 0) {
        const remediation = `ac remove ${current.name} --yes --force-worktree`;
        throw new Error(`git worktree remove did not remove the recorded worktree: ${commandError('git worktree remove', result).message}. After reviewing its dirty or untracked files, retry with ${remediation}.`);
      }
    }
    current = withCleanup(current, 'worktree');
    await save(current);
  }

  if (!current.cleanup?.branch) {
    if (branchPresent && branchOid && baseOid) {
      const transaction = `start\nverify ${baseRef} ${baseOid}\ndelete refs/heads/${current.branch} ${branchOid}\nprepare\ncommit\n`;
      const branchResult = await runner.run('git', ['update-ref', '--stdin'], withSignal({ cwd: current.repoRoot, input: transaction }, options.signal));
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

async function worktreeAddRecoveryError(cause: unknown, repoRoot: string, worktree: string, branch: string, runner: ProcessRunner): Promise<Error> {
  const inspectionSignal = AbortSignal.timeout(5_000);
  const branchRef = `refs/heads/${branch}`;
  let branchState: string;
  let worktreeState: string;
  try {
    const branchResult = await runner.run('git', ['show-ref', '--verify', '--quiet', branchRef], withSignal({ cwd: repoRoot }, inspectionSignal));
    branchState = branchResult.code === 0 ? 'present' : branchResult.code === 1 ? 'absent' : `inspection failed (${branchResult.code})`;
  } catch { branchState = 'inspection failed'; }
  try {
    const worktrees = await runner.run('git', ['worktree', 'list', '--porcelain'], withSignal({ cwd: repoRoot }, inspectionSignal));
    worktreeState = worktrees.code === 0 && worktrees.stdout.split('\n').some((line) => line === `worktree ${worktree}`) ? 'present' : worktrees.code === 0 ? 'absent' : `inspection failed (${worktrees.code})`;
  } catch { worktreeState = 'inspection failed'; }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${detail}. A failed or interrupted git worktree add may have created data; Agent Containers left it intact. Inspect with git worktree list: expected worktree ${worktree} is ${worktreeState}; expected local branch ${branchRef} is ${branchState}. Do not delete either until you have reviewed it.`, { cause });
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

function localBaseRef(base: string): string {
  if (!base || base.startsWith('refs/') || base.startsWith('origin/') || /^[0-9a-f]{40,64}$/i.test(base)) {
    throw new Error('Base must be a local branch name that resolves under refs/heads/.');
  }
  return `refs/heads/${base}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
