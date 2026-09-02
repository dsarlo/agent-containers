import { lstat, realpath } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, win32 } from 'node:path';
import type { AgentContainersConfig, ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import { validateWorkspaceName } from './names.js';
import { bootstrapManualRecoveryJournal, deleteMetadata, isAgentContainersWorkspace, isCanonicalContainerId, loadMetadata, saveMetadata, type WorkspaceMetadata } from './state.js';
import { getAuthoritativeWindowsDirectory } from './durability.js';

export type { ProcessRunner } from './types.js';

/** Keep enough terminal output for Dev Containers' final JSON record without unbounded memory use. */
export const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_OUTPUT_EVENT_LIMIT = 64 * 1024;
const WINDOWS_REAP_TIMEOUT_MS = 5_000;
const POSIX_REAP_GRACE_MS = 1_000;
const POSIX_REAP_VERIFICATION_TIMEOUT_MS = 5_000;

export interface NodeProcessRunnerDependencies {
  /** Override only for focused cross-platform process-runner tests. */
  platform?: NodeJS.Platform;
  /** Override only for focused cross-platform process-runner tests. */
  spawn?: typeof spawn;
  /** Bound Windows cancellation reaping without making focused tests wait seconds. */
  windowsReapTimeoutMs?: number;
  /** Override cancellation timing only for focused process-runner tests. */
  posixGraceMs?: number;
  /** Override process-group verification timing only for focused process-runner tests. */
  posixVerificationTimeoutMs?: number;
  /** Override process-group signalling only for focused process-runner tests. */
  processKill?: typeof process.kill;
  /** Override the native Windows-directory bridge for focused process-runner tests. */
  windowsDirectory?: () => string | undefined;
  /** Override cancellation timers only for focused process-runner tests. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** A local lifecycle transport could not be confirmed reaped. */
export class UnconfirmedProcessReapError extends Error {
  constructor() {
    super('Local lifecycle process-tree or process-group reaping timed out before it could be confirmed; operator recovery is required.');
    this.name = 'UnconfirmedProcessReapError';
  }
}

export function createNodeProcessRunner({
  platform = process.platform,
  spawn: spawnProcess = spawn,
  windowsReapTimeoutMs = WINDOWS_REAP_TIMEOUT_MS,
  posixGraceMs = POSIX_REAP_GRACE_MS,
  posixVerificationTimeoutMs = POSIX_REAP_VERIFICATION_TIMEOUT_MS,
  processKill = process.kill,
  windowsDirectory = getAuthoritativeWindowsDirectory,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancelTimer = clearTimeout,
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
        let cancellationTimer: NodeJS.Timeout | undefined;
        let cancellationDeadline: NodeJS.Timeout | undefined;
        let cancellationStarted = false;
        let windowsReaper: ChildProcess | undefined;
        let windowsReaperLive = false;
        let windowsTaskkillSucceeded = false;
        let rootExited = false;
        let rootClosed = false;
        let posixGroupGone = false;
        let rootTerminationAttempted = false;
        const terminateRootOnce = () => {
          if (rootTerminationAttempted || rootExited) return;
          rootTerminationAttempted = true;
          terminateManagedRoot(child);
        };
        const cleanup = () => {
          options.signal?.removeEventListener('abort', abortChild);
          if (cancellationTimer) cancelTimer(cancellationTimer);
          if (cancellationDeadline) cancelTimer(cancellationDeadline);
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
          if (settled || cancellationStarted) return;
          if (rootExited) {
            // The exited root PID may already have been recycled, so do not
            // target it. Close still confirms normal completion; otherwise
            // retain the lock only until bounded reap uncertainty is reported.
            cancellationDeadline = schedule(unconfirmed, platform === 'win32' ? windowsReapTimeoutMs : posixGraceMs + posixVerificationTimeoutMs);
            return;
          }
          cancellationStarted = true;
          if (platform === 'win32') {
            reapWindowsProcessTree();
            return;
          }
          reapPosixProcessGroup();
        };
        // Root exit cannot prove descendants remained in the local boundary.
        const finishCancellation = () => unconfirmed();
        const unconfirmed = () => fail(options.kind === 'lifecycle' ? new UnconfirmedProcessReapError() : processReapTimeoutError(platform));
        const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
          if (rootExited || child.pid === undefined) return false;
          try {
            processKill(-child.pid, signal);
            return true;
          } catch (error: unknown) {
            if (isNodeError(error, 'ESRCH')) return false;
            throw error;
          }
        };
        const reapPosixProcessGroup = () => {
          try {
            // Bound even an initial ESRCH race: the root may never emit close.
            cancellationDeadline = schedule(unconfirmed, posixGraceMs + posixVerificationTimeoutMs);
            posixGroupGone = !signalGroup('SIGTERM');
            if (posixGroupGone && rootClosed) return unconfirmed();
            cancellationTimer = schedule(() => {
              try {
                // Probe immediately before escalation. This avoids a known-gone
                // group, but cannot close the POSIX PGID-reuse race; once the
                // original root closed, fail closed rather than risk SIGKILL.
                posixGroupGone = !signalGroup(0);
                if (!posixGroupGone && !rootClosed) {
                  signalGroup('SIGKILL');
                  posixGroupGone = !signalGroup(0);
                }
                if (posixGroupGone && rootClosed) unconfirmed();
              } catch { /* deadline reports uncertainty */ }
            }, posixGraceMs);
          } catch { unconfirmed(); }
        };
        const reapWindowsProcessTree = () => {
          // Start the bounded recovery clock before any direct fallback can fail.
          cancellationDeadline = schedule(() => {
            try {
              if (windowsReaper && typeof windowsReaper.kill === 'function') terminateManagedRoot(windowsReaper);
              terminateRootOnce();
            } catch {
              // The deadline is recovery, not a second opportunity to surface a generic error.
            }
            unconfirmed();
          }, windowsReapTimeoutMs);
          if (child.pid === undefined) {
            try { terminateRootOnce(); } catch { unconfirmed(); }
          } else {
            let killer: ChildProcess;
            try {
              const directory = windowsDirectory();
              if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || directory === undefined) throw new Error('authoritative taskkill path unavailable');
              killer = spawnProcess(win32.join(directory, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
              windowsReaper = killer;
              windowsReaperLive = true;
            } catch {
              try { terminateRootOnce(); } catch { unconfirmed(); }
              return;
            }
            let killerSettled = false;
            const fallback = () => {
              if (killerSettled) return;
              killerSettled = true;
              windowsReaperLive = false;
              try { terminateRootOnce(); } catch { unconfirmed(); }
              if (rootClosed) finishCancellation();
            };
            killer.once('error', fallback);
            killer.once('close', (code) => {
              if (killerSettled) return;
              killerSettled = true;
              windowsReaperLive = false;
              if (code === 0) {
                windowsTaskkillSucceeded = true;
                // taskkill cannot prove tree completeness, but its managed root
                // must still close before the lifecycle can release its lock.
                if (rootClosed) finishCancellation();
              } else {
                try { terminateRootOnce(); } catch { unconfirmed(); }
                if (rootClosed) finishCancellation();
              }
            });
          }
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
        child.on('error', (error) => {
          if (cancellationStarted) unconfirmed();
          else fail(error);
        });
        child.on('exit', () => {
          rootExited = true;
        });
        child.on('close', (code) => {
          rootClosed = true;
          receive('stdout', Buffer.alloc(0), true);
          receive('stderr', Buffer.alloc(0), true);
          const rootResult = { code: code ?? 1, stdout, stderr, terminal: true as const };
          if (!cancellationStarted) settle(rootResult);
          else if (platform !== 'win32' && posixGroupGone) finishCancellation();
          else if (platform === 'win32' && (windowsTaskkillSucceeded || !windowsReaperLive)) {
            finishCancellation();
          }
        });
        options.signal?.addEventListener('abort', abortChild, { once: true });
      });
    },
  };
}

export const nodeProcessRunner: ProcessRunner = createNodeProcessRunner();

function processReapTimeoutError(platform: NodeJS.Platform): Error {
  return new Error(`${platform === 'win32' ? 'Windows process-tree' : 'POSIX process-group'} reaping could not be confirmed before the bounded cancellation deadline.`);
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
  const root = await findGitRoot(options.cwd, options.runner, options.signal, 'lifecycle');
  const worktree = resolve(root, options.config.workspace.worktreeRoot, name);
  try {
    await lstat(worktree);
    throw new Error(`Workspace path already exists: ${worktree}`);
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const branch = `agent-containers/${name}`;
  const branchResult = await options.runner.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], withSignal({ cwd: root, kind: 'lifecycle' }, options.signal));
  if (branchResult.code === 0) throw new Error(`Git branch ${branch} already exists.`);
  if (branchResult.code !== 1) throw commandError('git show-ref', branchResult);
  const baseRef = localBaseRef(options.baseBranch ?? options.config.workspace.baseBranch);
  const base = await options.runner.run('git', ['show-ref', '--verify', '--quiet', baseRef], withSignal({ cwd: root, kind: 'lifecycle' }, options.signal));
  if (base.code === 1) throw new Error(`Base must name an existing local branch under refs/heads/: ${baseRef}.`);
  if (base.code !== 0) throw commandError('git show-ref', base);
  const relativePaths = await supportsRelativeWorktreePaths(root, options.runner, options.signal, 'lifecycle');
  if (!relativePaths) throw new Error('Agent Containers requires Git support for git worktree add --relative-paths so Dev Containers can use Git inside linked worktrees.');
  let result: ProcessResult;
  try {
    result = await options.runner.run('git', ['worktree', 'add', '--relative-paths', '-b', branch, worktree, baseRef], withSignal({ cwd: root, kind: 'lifecycle' }, options.signal));
  } catch (error: unknown) {
    if (error instanceof UnconfirmedProcessReapError) throw error;
    throw await worktreeAddRecoveryError(error, root, worktree, branch, options.runner);
  }
  if (result.code !== 0) throw await worktreeAddRecoveryError(commandError('git worktree add', result), root, worktree, branch, options.runner);
  const metadata: WorkspaceMetadata = {
    version: 2,
    backend: 'local',
    handle: { kind: 'local' },
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
  if (metadata.containerId !== undefined && !isCanonicalContainerId(metadata.containerId)) throw new Error('Refusing to inspect or remove a legacy or non-canonical recorded Docker container ID. Verify it manually and repair the metadata first.');
  let current = metadata;

  let worktreePresent = false;
  if (!current.cleanup?.worktree) {
    const worktrees = await runner.run('git', ['worktree', 'list', '--porcelain'], withSignal({ cwd: current.repoRoot, kind: 'lifecycle' }, options.signal));
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
    const branch = await runner.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${current.branch}`], withSignal({ cwd: current.repoRoot, kind: 'lifecycle' }, options.signal));
    if (branch.code === 0) branchPresent = true;
    else if (branch.code !== 1) throw commandError('git show-ref', branch);
    if (branchPresent) {
      const revision = await runner.run('git', ['rev-parse', '--verify', `refs/heads/${current.branch}`], withSignal({ cwd: current.repoRoot, kind: 'lifecycle' }, options.signal));
      if (revision.code !== 0) throw commandError('git rev-parse', revision);
      branchOid = revision.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(branchOid)) throw new Error(`git rev-parse returned an invalid branch object ID for ${current.branch}.`);
      const baseRevision = await runner.run('git', ['rev-parse', '--verify', baseRef], withSignal({ cwd: current.repoRoot, kind: 'lifecycle' }, options.signal));
      if (baseRevision.code !== 0) throw commandError('git rev-parse', baseRevision);
      baseOid = baseRevision.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(baseOid)) throw new Error(`git rev-parse returned an invalid base object ID for ${baseRef}.`);
      const merged = await runner.run('git', ['merge-base', '--is-ancestor', branchOid, baseOid], withSignal({ cwd: current.repoRoot, kind: 'lifecycle' }, options.signal));
      if (merged.code === 1) throw new Error(`Refusing to remove unmerged branch ${current.branch}; merge it into ${baseRef} first.`);
      if (merged.code !== 0) throw commandError('git merge-base', merged);
    }
  }

  if (worktreePresent && !current.cleanup?.worktree && !options.forceWorktree) {
    const status = await runner.run('git', ['status', '--porcelain=v1', '--untracked-files=all'], withSignal({ cwd: current.worktree, kind: 'lifecycle' }, options.signal));
    if (status.code !== 0) throw commandError('git status', status);
    if (status.stdout.trim()) {
      throw new Error(`Refusing to remove dirty or untracked worktree ${current.worktree}. After reviewing its files, retry with ac remove ${current.name} --yes --force-worktree.`);
    }
  }

  if (current.containerId && !current.cleanup?.container && !options.skipContainerCleanup) {
    const inspect = await runner.run('docker', ['inspect', '--format', '{{.Id}}\n{{ index .Config.Labels "devcontainer.local_folder" }}', current.containerId], withSignal({ kind: 'lifecycle' }, options.signal));
    if (inspect.code !== 0) {
      if (!containerIsAlreadyGone(inspect)) throw commandError('docker inspect', inspect);
    } else if (!isOwnedContainerInspection(inspect.stdout, current.containerId, current.worktree)) {
      throw new Error('Refusing to remove: recorded Dev Container is not bound to the recorded worktree.');
    }
    if (inspect.code === 0) {
      const container = await runner.run('docker', ['rm', '-f', current.containerId], withSignal({ kind: 'lifecycle' }, options.signal));
      if (container.code !== 0) throw commandError('docker rm', container);
    }
    current = withCleanup(current, 'container');
    await save(current);
  }

  if (!current.cleanup?.worktree) {
    if (worktreePresent) {
      const result = await runner.run('git', ['worktree', 'remove', ...(options.forceWorktree ? ['--force'] : []), current.worktree], withSignal({ cwd: current.repoRoot, kind: 'lifecycle' }, options.signal));
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
      const branchResult = await runner.run('git', ['update-ref', '--stdin'], withSignal({ cwd: current.repoRoot, input: transaction, kind: 'lifecycle' }, options.signal));
      if (branchResult.code !== 0) throw commandError('git update-ref', branchResult);
    }
    current = withCleanup(current, 'branch');
    await save(current);
  }
  await removeMetadata();
}

function isOwnedContainerInspection(output: string, containerId: string, worktree: string): boolean {
  const [id, label, ...extra] = output.replace(/\r/g, '').trimEnd().split('\n');
  return extra.length === 0 && id === containerId && label === worktree;
}

export async function removeWorkspaceMetadata(stateDir: string, name: string): Promise<void> {
  await deleteMetadata(stateDir, name);
}

export async function findGitRoot(cwd: string, runner: ProcessRunner, signal?: AbortSignal, kind: ProcessRunOptions['kind'] = 'readonly-probe'): Promise<string> {
  const result = await runner.run('git', ['rev-parse', '--show-toplevel'], withSignal({ cwd, kind }, signal));
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

async function supportsRelativeWorktreePaths(cwd: string, runner: ProcessRunner, signal?: AbortSignal, kind: ProcessRunOptions['kind'] = 'readonly-probe'): Promise<boolean> {
  const help = await runner.run('git', ['worktree', 'add', '-h'], withSignal({ cwd, kind }, signal));
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
    const branchResult = await runner.run('git', ['show-ref', '--verify', '--quiet', branchRef], withSignal({ cwd: repoRoot, kind: 'lifecycle' }, inspectionSignal));
    branchState = branchResult.code === 0 ? 'present' : branchResult.code === 1 ? 'absent' : `inspection failed (${branchResult.code})`;
  } catch (error: unknown) {
    if (error instanceof UnconfirmedProcessReapError) throw error;
    branchState = 'inspection failed';
  }
  try {
    const worktrees = await runner.run('git', ['worktree', 'list', '--porcelain'], withSignal({ cwd: repoRoot, kind: 'lifecycle' }, inspectionSignal));
    worktreeState = worktrees.code === 0 && worktrees.stdout.split('\n').some((line) => line === `worktree ${worktree}`) ? 'present' : worktrees.code === 0 ? 'absent' : `inspection failed (${worktrees.code})`;
  } catch (error: unknown) {
    if (error instanceof UnconfirmedProcessReapError) throw error;
    worktreeState = 'inspection failed';
  }
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
