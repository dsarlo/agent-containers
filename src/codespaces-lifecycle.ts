import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodespacesAgentContainersConfig } from './types.js';
import type { GhCodespacesProvider } from './codespaces.js';
import { verifyCodespacesIdentity } from './codespaces-create.js';
import { loadCommandStatus, saveCommandStatus } from './codespaces-command.js';
import { recordCodespacesEvent } from './codespaces-ops.js';
import { loadMetadata, metadataGeneration, saveMetadata, type CodespacesWorkspaceMetadata } from './state.js';
import { canReportRunning, capacityReport, categorizeWorkspace, withGlobalCapacityLock } from './codespaces-capacity.js';

export interface CodespacesLifecycleDependencies {
  stateDir: string;
  name: string;
  provider: GhCodespacesProvider;
  config: CodespacesAgentContainersConfig;
  now?: () => string;
}

export type ReconcileOutcome = 'matched' | 'missing' | 'mismatch' | 'unreachable' | 'ambiguous';

export async function reconcileCodespacesWorkspace(deps: CodespacesLifecycleDependencies): Promise<ReconcileOutcome> {
  const metadata = await exactMetadata(deps);
  try {
    const resource = await deps.provider.get(metadata.remote.name);
    return verifyCodespacesIdentity(metadata, resource).ok ? 'matched' : 'mismatch';
  } catch (error) {
    return isNotFound(error) ? 'missing' : 'unreachable';
  }
}

export async function stopCodespacesWorkspace(deps: CodespacesLifecycleDependencies): Promise<void> {
  const metadata = await exactMetadata(deps);
  await assertNoActiveCommand(deps.stateDir);
  await mutate(deps, metadata, 'stop', 'stop-requested', async () => {
    await verifyBeforeMutation(deps, metadata);
    await deps.provider.setState(metadata.remote.name, 'Shutdown');
    const readback = await deps.provider.get(metadata.remote.name);
    if (!verifyCodespacesIdentity(metadata, readback).ok || !/stopp|shutdown/i.test(readback.state)) throw new Error('Stop readback did not prove the exact recorded Codespace is stopped.');
    await markStoppedCommands(deps.stateDir);
    return { normalized: 'stopped', providerRawState: readback.state, cleanup: { ...metadata.cleanup, remoteStopped: true } };
  });
}

export async function startCodespacesWorkspace(deps: CodespacesLifecycleDependencies): Promise<void> {
  await withGlobalCapacityLock({ stateDir: deps.stateDir, policy: deps.config.backends.codespaces, sample: () => sampleCapacity(deps.stateDir) }, async () => {
    const metadata = await exactMetadata(deps);
    const report = capacityReport(await sampleCapacity(deps.stateDir), deps.config.backends.codespaces);
    if (!canReportRunning(report)) throw new Error(`Codespaces running capacity is exhausted (${report.slots.running}/${report.slots.maxRunning} running).`);
    await mutate(deps, metadata, 'start', 'start-requested', async () => {
      await verifyBeforeMutation(deps, metadata);
      await deps.provider.setState(metadata.remote.name, 'Running');
      const readback = await deps.provider.get(metadata.remote.name);
      if (!verifyCodespacesIdentity(metadata, readback).ok || !/running|available|starting/i.test(readback.state)) throw new Error('Start readback did not prove the exact recorded Codespace is running.');
      return { normalized: 'starting', providerRawState: readback.state, cleanup: metadata.cleanup };
    });
  });
}

/** Delete only after an explicit separate remote-data-loss acknowledgement.
 * A missing/readback-uncertain resource remains a durable metadata tombstone. */
export async function removeCodespacesWorkspace(deps: CodespacesLifecycleDependencies, forceRemoteDataLoss: boolean): Promise<void> {
  if (!forceRemoteDataLoss) throw new Error('Codespaces removal requires --force-remote-data-loss; this is distinct from --yes.');
  const metadata = await exactMetadata(deps);
  await assertNoActiveCommand(deps.stateDir);
  await mutate(deps, metadata, 'remove', 'remove-requested', async () => {
    await verifyBeforeMutation(deps, metadata);
    await deps.provider.delete(metadata.remote.name);
    try {
      await deps.provider.get(metadata.remote.name);
      throw new Error('Delete readback still returned the exact Codespace; removal is blocked.');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return { normalized: 'tombstoned', providerRawState: 'Deleted', cleanup: { ...metadata.cleanup, remoteDeleted: true, tombstoneWritten: true } };
  });
}

async function exactMetadata(deps: CodespacesLifecycleDependencies): Promise<CodespacesWorkspaceMetadata> {
  const metadata = await loadMetadata(deps.stateDir, deps.name);
  if (!metadata || metadata.version !== 2 || metadata.backend !== 'codespaces') throw new Error('No exact recorded Codespaces workspace exists.');
  if (metadata.recovery) throw new Error('Codespaces lifecycle is BLOCKED by durable recovery; acknowledge the exact remote state before mutation.');
  return metadata;
}

async function verifyBeforeMutation(deps: CodespacesLifecycleDependencies, metadata: CodespacesWorkspaceMetadata): Promise<void> {
  const actor = await deps.provider.actor();
  if (actor.id !== metadata.control.actorId) throw new Error('Authenticated actor drifted from the recorded owner; lifecycle is BLOCKED.');
  const resource = await deps.provider.get(metadata.remote.name);
  if (!verifyCodespacesIdentity(metadata, resource).ok) throw new Error('Exact Codespace identity drifted; lifecycle is BLOCKED.');
}

async function mutate(deps: CodespacesLifecycleDependencies, metadata: CodespacesWorkspaceMetadata, kind: 'stop' | 'start' | 'remove', event: 'stop-requested' | 'start-requested' | 'remove-requested', action: () => Promise<{ normalized: string; providerRawState: string; cleanup: CodespacesWorkspaceMetadata['cleanup'] }>): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  const operationId = randomUUID();
  const prepared = { ...metadata, lifecycle: { ...metadata.lifecycle, activeOperation: { id: operationId, kind, startedAt: now(), checkpoint: 'identity-verifying' } } };
  await saveMetadata(deps.stateDir, prepared, { expectedGeneration: metadataGeneration(metadata) });
  await recordCodespacesEvent(deps.stateDir, { event, workspaceName: metadata.name, operationId, requestId: null, actorId: metadata.control.actorId, repositoryId: metadata.repository.id, codespaceId: metadata.remote.codespaceId, previous: metadata.lifecycle.normalized, next: kind, detail: null });
  try {
    const result = await action();
    const current = await exactMetadata(deps);
    const next = { ...current, lifecycle: { ...current.lifecycle, desired: kind === 'stop' ? 'stopped' : kind === 'start' ? 'ready' : current.lifecycle.desired, normalized: result.normalized, providerRawState: result.providerRawState, lastObservedAt: now(), activeOperation: null }, cleanup: result.cleanup, recovery: null };
    await saveMetadata(deps.stateDir, next, { expectedGeneration: metadataGeneration(current) });
    await recordCodespacesEvent(deps.stateDir, { event: kind === 'remove' ? 'tombstone-written' : kind === 'stop' ? 'stop-verified' : 'start-verified', workspaceName: metadata.name, operationId, requestId: null, actorId: metadata.control.actorId, repositoryId: metadata.repository.id, codespaceId: metadata.remote.codespaceId, previous: kind, next: next.lifecycle.normalized, detail: null });
  } catch (error) {
    const current = await loadMetadata(deps.stateDir, deps.name);
    if (current?.version === 2 && current.backend === 'codespaces') await saveMetadata(deps.stateDir, { ...current, recovery: { reason: `${kind}-ambiguous`, operationId, recordedAt: now() }, lifecycle: { ...current.lifecycle, normalized: 'recovery-required', activeOperation: null } }, { expectedGeneration: metadataGeneration(current) });
    throw error;
  }
}

async function assertNoActiveCommand(stateDir: string): Promise<void> {
  let ids: string[];
  try { ids = await readdir(join(stateDir, 'codespaces', 'commands')); } catch { return; }
  for (const id of ids) {
    const status = await loadCommandStatus(stateDir, id);
    if (status && ['accepted', 'starting', 'running', 'detached', 'cancel-outcome-unknown', 'outcome-unknown'].includes(status.state)) throw new Error(`Lifecycle is refused while remote command ${id} may be active or unknown.`);
  }
}

async function markStoppedCommands(stateDir: string): Promise<void> {
  let ids: string[];
  try { ids = await readdir(join(stateDir, 'codespaces', 'commands')); } catch { return; }
  for (const id of ids) {
    const status = await loadCommandStatus(stateDir, id);
    if (status && ['accepted', 'starting', 'running', 'detached'].includes(status.state)) await saveCommandStatus(stateDir, { ...status, state: 'terminated-by-workspace-stop', exitCode: null, transport: 'detached', exitedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
}

async function sampleCapacity(stateDir: string): Promise<Array<{ name: string; category: NonNullable<ReturnType<typeof categorizeWorkspace>> }>> {
  let names: string[];
  try { names = await readdir(join(stateDir, 'workspaces')); } catch { return []; }
  const counted: Array<{ name: string; category: NonNullable<ReturnType<typeof categorizeWorkspace>> }> = [];
  for (const name of names) {
    // Metadata publication may leave adapter-owned temporary entries beside
    // workspace records; those are not capacity reservations.
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) continue;
    const metadata = await loadMetadata(stateDir, name);
    if (metadata?.version !== 2 || metadata.backend !== 'codespaces') continue;
    const category = categorizeWorkspace(metadata);
    if (category) counted.push({ name, category });
  }
  return counted;
}

function isNotFound(error: unknown): boolean { return error instanceof Error && /404|not found|codespaces name/i.test(error.message); }
