import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalContainerId, isLocalWorkspaceMetadata, listMetadata, loadManualRecovery, type WorkspaceMetadata } from './state.js';
import type { ProcessRunner } from './types.js';

export type ObservationState = 'clean' | 'dirty' | 'present' | 'missing' | 'unknown' | 'ambiguous' | 'not-recorded' | 'unprobed';
export interface WorkspaceInventory {
  name: string;
  backend: 'local' | 'codespaces';
  createdAt: string;
  activityAt: string;
  branch?: string;
  base?: string;
  worktree: { path?: string; state: ObservationState };
  container: { state: ObservationState };
  lock: 'none' | 'present' | 'unknown';
  recovery: 'none' | 'required' | 'unknown';
  cleanup: Record<string, boolean>;
}

/** Read-only inventory: it never writes metadata, adopts resources, or runs lifecycle commands. */
export async function inventoryWorkspaces(stateDir: string, runner: ProcessRunner, options: { probe?: boolean; names?: readonly string[] } = {}): Promise<WorkspaceInventory[]> {
  const entries = await listMetadata(stateDir);
  const selected = options.names && options.names.length > 0 ? entries.filter((entry) => options.names!.includes(entry.name)) : entries;
  return Promise.all(selected.map((metadata) => inventoryWorkspace(stateDir, metadata, runner, options.probe === true)));
}

async function inventoryWorkspace(stateDir: string, metadata: WorkspaceMetadata, runner: ProcessRunner, probe: boolean): Promise<WorkspaceInventory> {
  const recovery = isLocalWorkspaceMetadata(metadata) ? await recoveryState(stateDir, metadata.name) : metadata.recovery ? 'required' : await recoveryState(stateDir, metadata.name);
  const lock = await lockState(stateDir, metadata.name);
  if (!isLocalWorkspaceMetadata(metadata)) {
    return { name: metadata.name, backend: 'codespaces', createdAt: metadata.createdAt, activityAt: metadata.lifecycle.lastObservedAt, branch: metadata.source.effectiveBranch, base: metadata.source.requestedRef, worktree: { state: 'not-recorded' }, container: { state: probe ? 'unknown' : 'unprobed' }, lock: metadata.lifecycle.activeOperation ? 'present' : lock, recovery, cleanup: { ...metadata.cleanup } };
  }
  const worktree = await inspectWorktree(metadata.worktree, runner, probe);
  const container = await inspectContainer(metadata.containerId, metadata.worktree, runner, probe);
  const activityAt = await localActivityAt(metadata.worktree, metadata.createdAt);
  return { name: metadata.name, backend: 'local', createdAt: metadata.createdAt, activityAt, branch: metadata.branch, base: metadata.baseRef, worktree: { path: metadata.worktree, state: worktree }, container: { state: container }, lock, recovery, cleanup: { container: false, worktree: false, branch: false, ...metadata.cleanup } };
}

async function localActivityAt(path: string, fallback: string): Promise<string> {
  try { return (await lstat(path)).mtime.toISOString(); } catch { return fallback; }
}

async function inspectWorktree(path: string, runner: ProcessRunner, probe: boolean): Promise<ObservationState> {
  try { await lstat(path); } catch (error: unknown) { if (isErrno(error, 'ENOENT')) return 'missing'; return 'unknown'; }
  if (!probe) return 'unprobed';
  try {
    const result = await runner.run('git', ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: path, kind: 'readonly-probe', signal: AbortSignal.timeout(5_000) });
    if (result.code !== 0) return 'unknown';
    return result.stdout.trim() ? 'dirty' : 'clean';
  } catch { return 'unknown'; }
}

async function inspectContainer(id: string | undefined, worktree: string, runner: ProcessRunner, probe: boolean): Promise<ObservationState> {
  if (!id) return 'not-recorded';
  if (!isCanonicalContainerId(id)) return 'ambiguous';
  if (!probe) return 'unprobed';
  const signal = AbortSignal.timeout(5_000);
  try {
    const candidates = await runner.run('docker', ['ps', '-a', '--filter', `label=devcontainer.local_folder=${worktree}`, '--format', '{{.ID}}'], { kind: 'readonly-probe', signal });
    if (candidates.code !== 0) return 'unknown';
    const observed = terminalLines(candidates.stdout);
    if (observed.length === 0) return 'missing';
    if (observed.length !== 1 || observed[0] !== id) return 'ambiguous';
    const result = await runner.run('docker', ['inspect', '--format', '{{.Id}}\n{{ index .Config.Labels "devcontainer.local_folder" }}', id], { kind: 'readonly-probe', signal });
    if (result.code !== 0) return /no such (object|container)/i.test(`${result.stdout}\n${result.stderr}`) ? 'missing' : 'unknown';
    const lines = terminalLines(result.stdout);
    return lines.length === 2 && lines[0] === id && lines[1] === worktree ? 'present' : 'ambiguous';
  } catch { return 'unknown'; }
}

async function recoveryState(stateDir: string, name: string): Promise<WorkspaceInventory['recovery']> {
  try { return await loadManualRecovery(stateDir, name) ? 'required' : 'none'; } catch { return 'unknown'; }
}

async function lockState(stateDir: string, name: string): Promise<WorkspaceInventory['lock']> {
  try {
    await Promise.any([lstat(join(stateDir, 'locks', `${name}.lock`)), lstat(join(stateDir, 'locks', `${name}.reap-unconfirmed`)), lstat(join(stateDir, 'locks', `${name}.recovery`))]);
    return 'present';
  } catch (error: unknown) {
    if (error instanceof AggregateError && error.errors.every((entry) => isErrno(entry, 'ENOENT'))) return 'none';
    return 'unknown';
  }
}

export function staleCandidates(entries: readonly WorkspaceInventory[], olderThanMs: number, now = Date.now()): WorkspaceInventory[] {
  return entries.filter((entry) => {
    const activity = Date.parse(entry.activityAt);
    return Number.isFinite(activity) && now - activity >= olderThanMs;
  });
}

function terminalLines(output: string): string[] {
  const withoutTerminalNewline = output.endsWith('\r\n') ? output.slice(0, -2) : output.endsWith('\n') ? output.slice(0, -1) : output;
  return withoutTerminalNewline === '' ? [] : withoutTerminalNewline.split(/\r?\n/);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
