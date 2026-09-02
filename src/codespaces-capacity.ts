import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getProductionStateDurabilityAdapter, type StateDurabilityAdapter } from './durability.js';
import type { CodespacesOperationState } from './codespaces-ops.js';
import type { CodespacesWorkspaceMetadata } from './state.js';

export type CapacityCategory = 'creating' | 'running' | 'stopped' | 'uncertain';

export interface CapacityCountedWorkspace { name: string; category: CapacityCategory }
export interface CapacityPolicy { maxCreating: number; maxRunning: number; maxTotal: number }
export interface CapacitySlots { maxCreating: number; maxRunning: number; maxTotal: number; creating: number; running: number; total: number }
export interface CapacityReport {
  allowed: boolean;
  slots: CapacitySlots;
  blockers: string[];
  existing: readonly CapacityCountedWorkspace[];
}

export interface GlobalCapacityLockOptions {
  stateDir: string;
  policy: CapacityPolicy;
  /** Read the durable workspaces and create intents that currently consume slots. */
  sample: () => Promise<readonly CapacityCountedWorkspace[]>;
  signal?: AbortSignal;
  now?: () => number;
  ownerAlive?: (pid: number) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  waitTimeoutMs?: number;
}

interface LockOwner { pid: number; token: string; createdAt: string }

let testDurabilityAdapter: StateDurabilityAdapter | undefined;
export function setCodespacesCapacityDurabilityAdapterForTesting(adapter: StateDurabilityAdapter | undefined): void {
  testDurabilityAdapter = adapter;
}

export function codespacesCapacityLockDir(stateDir: string): string {
  return join(stateDir, 'codespaces', 'capacity');
}

/** Conservative slot accounting: creating/running/stopped/recovery and unknown all consume total slots. */
export function capacityReport(existing: readonly CapacityCountedWorkspace[], policy: CapacityPolicy): CapacityReport {
  const creating = existing.filter((entry) => entry.category === 'creating').length;
  const running = existing.filter((entry) => entry.category === 'running').length;
  const total = existing.length;
  const blockers: string[] = [];
  if (creating + 1 > policy.maxCreating) blockers.push(`already creating ${creating}/${policy.maxCreating}`);
  if (running > policy.maxRunning) blockers.push(`already running ${running}/${policy.maxRunning}`);
  if (total + 1 > policy.maxTotal) blockers.push(`total recorded Codespaces ${total}/${policy.maxTotal}`);
  return { allowed: blockers.length === 0, slots: { maxCreating: policy.maxCreating, maxRunning: policy.maxRunning, maxTotal: policy.maxTotal, creating, running, total }, blockers, existing };
}

/** A create may proceed only when the conservative creating and total slots can each accept one more. */
export function canReserveCreate(report: CapacityReport): boolean {
  return report.allowed && report.slots.creating + 1 <= report.slots.maxCreating && report.slots.total + 1 <= report.slots.maxTotal;
}

/** A workspace may be reported running only when the running slot has room. */
export function canReportRunning(report: CapacityReport): boolean {
  return report.slots.running + 1 <= report.slots.maxRunning;
}

export function categorizeWorkspace(metadata: CodespacesWorkspaceMetadata): CapacityCategory | undefined {
  const { normalized } = metadata.lifecycle;
  if (normalized === 'provisioning' || normalized === 'create-intent' || normalized === 'creating' || normalized === 'starting' || normalized === 'rebuilding') return 'creating';
  if (normalized === 'ready' || normalized === 'ready-without-setup-proof') return 'running';
  if (normalized === 'stopped') return 'stopped';
  return 'uncertain';
}

export function categorizeCreateIntent(state: CodespacesOperationState): CapacityCategory | undefined {
  if (state === 'recovery-cleared') return undefined;
  if (state === 'ambiguous-create' || state === 'recovery-required' || state === 'provider-error' || state === 'identity-mismatch' || state === 'revision-mismatch') return 'uncertain';
  return 'creating';
}

/**
 * Serialize create/start decisions across local harness processes with a
 * durable global lock under the state root. The slot reservation itself is the
 * durable create intent; this lock only orders the decision.
 */
export async function withGlobalCapacityLock<T>(options: GlobalCapacityLockOptions, action: () => Promise<T>): Promise<T> {
  const adapter = testDurabilityAdapter ?? getProductionStateDurabilityAdapter();
  await adapter.assertStateWriteSupport();
  const directory = codespacesCapacityLockDir(options.stateDir);
  await ensureDurableDirectory(directory, adapter);
  const lockPath = join(directory, 'lock');
  const now = options.now ?? Date.now;
  const ownerAlive = options.ownerAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (error: unknown) { return !isNodeError(error, 'ESRCH'); } });
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.waitTimeoutMs ?? 15_000);
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date(now()).toISOString() };
  while (true) {
    if (options.signal?.aborted) throw new Error('Codespaces capacity decision was cancelled while waiting for the global capacity lock.');
    let pending: string | undefined;
    try {
      const pendingPath = join(directory, `.${randomUUID()}.pending`);
      pending = pendingPath;
      await mkdir(pendingPath, { mode: 0o700 });
      await writeFile(join(pendingPath, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await adapter.syncFile(join(pendingPath, 'owner.json'));
      if (await adapter.publicationMode() === 'strict') { await adapter.syncDirectory(pendingPath); await rename(pendingPath, lockPath); await adapter.syncDirectory(directory); }
      else await adapter.moveFileWriteThrough(pendingPath, lockPath);
      return await runLocked(action, lockPath, directory, owner, adapter);
    } catch (error: unknown) {
      if (pending) await rm(pending, { recursive: true, force: true });
      if (!isLockContention(error)) throw error;
      const current = await readOwner(lockPath);
      if (current && !ownerAlive(current.pid)) {
        const quarantine = join(directory, `.${current.token}.reclaiming`);
        try {
          if (await adapter.publicationMode() === 'strict') await rename(lockPath, quarantine);
          else await adapter.moveFileWriteThrough(lockPath, quarantine);
          const quarantined = await readOwner(quarantine);
          if (!quarantined || quarantined.token !== current.token || quarantined.pid !== current.pid) throw new Error('Codespaces capacity lock ownership changed during reclamation; retrying without removing the new owner.', { cause: error });
          await rm(quarantine, { recursive: true, force: false });
          if (await adapter.publicationMode() === 'strict') await adapter.syncDirectory(directory);
          continue;
        } catch (reclaimError: unknown) {
          if (!isLockContention(reclaimError)) throw reclaimError;
        }
      }
      if (now() >= deadline) throw new Error('Codespaces capacity is being decided by an active unverifiable process; retry after it finishes.', { cause: error });
      await sleep(25);
    }
  }
}

async function runLocked<T>(action: () => Promise<T>, lockPath: string, directory: string, owner: LockOwner, adapter: StateDurabilityAdapter): Promise<T> {
  let result: T;
  try {
    result = await action();
  } catch (error: unknown) {
    await releaseLock(lockPath, directory, owner, adapter).catch(() => undefined);
    throw error;
  }
  await releaseLock(lockPath, directory, owner, adapter);
  return result;
}

async function releaseLock(lockPath: string, directory: string, owner: LockOwner, adapter: StateDurabilityAdapter): Promise<void> {
  const current = await readOwner(lockPath);
  if (!current || current.token !== owner.token || current.pid !== owner.pid) return;
  const released = join(directory, `.${owner.token}.released`);
  if (await adapter.publicationMode() === 'strict') await rename(lockPath, released);
  else await adapter.moveFileWriteThrough(lockPath, released);
  const moved = await readOwner(released);
  if (!moved || moved.token !== owner.token || moved.pid !== owner.pid) throw new Error('Codespaces capacity lock ownership changed during release; refusing to remove another owner.');
  await rm(released, { recursive: true, force: false });
  if (await adapter.publicationMode() === 'strict') await adapter.syncDirectory(directory);
}

export async function readCapacityLockOwner(stateDir: string): Promise<{ pid: number; token: string; createdAt: string } | undefined> {
  return readOwner(join(codespacesCapacityLockDir(stateDir), 'lock'));
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const owner: unknown = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (typeof owner !== 'object' || owner === null || !('pid' in owner) || !('token' in owner)) return undefined;
    const { pid, token, createdAt } = owner as { pid: unknown; token: unknown; createdAt?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof token !== 'string') return undefined;
    return { pid, token, createdAt: typeof createdAt === 'string' ? createdAt : '' };
  } catch { return undefined; }
}

function isLockContention(error: unknown): boolean {
  return isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY') || isNodeError(error, 'EPERM') || isNodeError(error, 'EACCES');
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
    try {
      await mkdir(created, { recursive: false, mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const entry = await lstat(created);
      if (!entry.isDirectory()) throw new Error(`Durable directory path is not a directory: ${created}`, { cause: error });
    }
    if (await adapter.publicationMode() !== 'recoverable') await adapter.syncDirectory(created);
    if (await adapter.publicationMode() !== 'recoverable') await adapter.syncDirectory(dirname(created));
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }