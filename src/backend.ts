import { randomUUID } from 'node:crypto';
import type { CommandEvent, ExecutionBackend, WorkspaceHandle, WorkspaceObservation } from './types.js';
import type { BackendKind, CodespacesAgentContainersConfig, ProcessRunner, RemoteCommandRequest } from './types.js';
import { GhCodespacesProvider } from './codespaces.js';
import { createCodespacesWorkspace, type CodespacesCreateOutcome } from './codespaces-create.js';
import { waitCodespacesReady } from './codespaces-readiness.js';
import { recordCodespacesEvent } from './codespaces-ops.js';
import { attachRemoteCommand, cancelRemoteCommand, createNodeSshSpawner, executeRemoteCommand, type SshSpawner } from './codespaces-transport.js';
import { listMetadata, type CodespacesWorkspaceMetadata } from './state.js';

/** Local lifecycle hooks keep the backend boundary injectable without changing durable records. */
export interface LocalExecutionLifecycle {
  create?(request: { name: string; backend: BackendKind }, signal?: AbortSignal): Promise<WorkspaceHandle>;
  observe?(handle: WorkspaceHandle, signal?: AbortSignal): Promise<WorkspaceObservation>;
  waitReady?(handle: WorkspaceHandle, signal?: AbortSignal): AsyncIterable<WorkspaceObservation>;
  execute?(handle: WorkspaceHandle, request: { commandId: string; argv: readonly [string, ...string[]] }, signal?: AbortSignal): AsyncIterable<CommandEvent>;
  attach?(handle: WorkspaceHandle, commandId: string, signal?: AbortSignal): AsyncIterable<CommandEvent>;
  cancel?(handle: WorkspaceHandle, commandId: string, signal?: AbortSignal): Promise<void>;
  recover?(handle: WorkspaceHandle, signal?: AbortSignal): Promise<void>;
  remove?(handle: WorkspaceHandle, signal?: AbortSignal): Promise<void>;
}

export type ExecutionBackendResolver = (kind: BackendKind) => ExecutionBackend;

/** Build the real local adapter around the existing local lifecycle operations. */
export function createLocalExecutionBackend(lifecycle: LocalExecutionLifecycle): ExecutionBackend {
  return {
    kind: 'local',
    async create(request, signal) { assertRequestName(request); return requireOperation(lifecycle.create, 'creation')(request, signal); },
    async observe(handle, signal) { assertHandle(handle, 'local'); return requireOperation(lifecycle.observe, 'observation')(handle, signal); },
    async *waitReady(handle, signal) { assertHandle(handle, 'local'); yield* requireOperation(lifecycle.waitReady, 'readiness')(handle, signal); },
    async *execute(handle, request, signal) { assertHandle(handle, 'local'); assertRequest(request); yield* requireOperation(lifecycle.execute, 'execution')(handle, request, signal); },
    async *attach(handle, commandId, signal) { assertHandle(handle, 'local'); if (!commandId) throw new Error('Command ID is invalid.'); yield* requireOperation(lifecycle.attach, 'attachment')(handle, commandId, signal); },
    async cancel(handle, commandId, signal) { assertHandle(handle, 'local'); if (!commandId) throw new Error('Command ID is invalid.'); await requireOperation(lifecycle.cancel, 'cancellation')(handle, commandId, signal); },
    async recover(handle, signal) { assertHandle(handle, 'local'); await requireOperation(lifecycle.recover, 'recovery')(handle, signal); },
    async remove(handle, signal) { assertHandle(handle, 'local'); await requireOperation(lifecycle.remove, 'removal')(handle, signal); },
  };
}

/** Resolve only known backends. Codespaces cannot reach local lifecycle hooks. */
export function resolveExecutionBackend(kind: BackendKind, localLifecycle: LocalExecutionLifecycle = {}): ExecutionBackend {
  return kind === 'local' ? createLocalExecutionBackend(localLifecycle) : codespacesGate;
}

export function assertBackendAvailable(kind: BackendKind): void {
  if (resolveExecutionBackend(kind).kind === 'codespaces') gated();
}

const codespacesGate: ExecutionBackend = {
  kind: 'codespaces',
  async create() { gated(); }, async observe() { gated(); }, waitReady() { return gated(); }, execute() { return gated(); }, attach() { return gated(); }, async cancel() { gated(); }, async recover() { gated(); }, async remove() { gated(); },
};
function gated(): never { throw new Error('Codespaces lifecycle is phase-gated and unavailable in this release.'); }

export interface CodespacesExecutionBackendDependencies {
  stateDir: string;
  config: CodespacesAgentContainersConfig;
  runner: ProcessRunner;
  root: string;
  ghVersion?: string;
  displayNameHint?: string | null;
  /** Test seam: streamed `gh codespace ssh` transport used for execution. */
  spawner?: SshSpawner;
}

/**
 * Real Codespaces backend behind the experimental gate. Create independently
 * repeats all critical preflight checks rather than trusting a prior doctor run.
 */
export function createCodespacesExecutionBackend(deps: CodespacesExecutionBackendDependencies): ExecutionBackend {
  const requireGate = () => { if (process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES !== '1') gated(); };
  const provider = new GhCodespacesProvider(deps.runner);
  return {
    kind: 'codespaces',
    async create(request, signal) {
      requireGate();
      if (request.backend !== 'codespaces' || !request.name || request.name.includes('\0')) throw new Error('Codespaces create request is invalid.');
      const outcome = await createCodespacesWorkspace({
        stateDir: deps.stateDir,
        requestId: randomUUID(),
        name: request.name,
        config: deps.config,
        root: deps.root,
        runner: deps.runner,
        provider,
        signal,
        ghVersion: deps.ghVersion ?? 'unknown',
        displayNameHint: deps.displayNameHint ?? null,
      });
      if (outcome.outcome === 'recorded') {
        return { kind: 'codespaces', id: outcome.metadata.workspaceId, name: outcome.metadata.remote.name, environmentId: outcome.metadata.remote.environmentId };
      }
      throw new Error(codespacesCreateOutcomeSummary(outcome));
    },
    async observe(handle) {
      requireGate();
      if (handle.kind !== 'codespaces') throw new Error('Backend handle mismatch: expected codespaces.');
      const metadata = await loadCodespacesHandleRecord(deps.stateDir, handle);
      return { backend: 'codespaces', state: metadata.lifecycle.normalized, observedAt: metadata.lifecycle.lastObservedAt };
    },
    async *waitReady(handle, signal) {
      requireGate();
      if (handle.kind !== 'codespaces') throw new Error('Backend handle mismatch: expected codespaces.');
      const metadata = await loadCodespacesHandleRecord(deps.stateDir, handle);
      yield* waitCodespacesReady({ stateDir: deps.stateDir, name: metadata.name, provider, config: deps.config, signal });
    },
    async *execute(handle, request, signal) {
      requireGate();
      if (handle.kind !== 'codespaces') throw new Error('Backend handle mismatch: expected codespaces.');
      assertRemoteRequest(request);
      const metadata = await loadCodespacesHandleRecord(deps.stateDir, handle);
      const logger = (input: Parameters<typeof recordCodespacesEvent>[1]) => recordCodespacesEvent(deps.stateDir, input);
      yield* executeRemoteCommand({
        stateDir: deps.stateDir, metadata, provider, root: deps.root, config: deps.config,
        spawner: deps.spawner ?? createNodeSshSpawner(), signal, logger,
      }, {
        commandId: request.commandId,
        argv: request.argv,
        mode: request.mode ?? 'pipe',
        cwd: request.cwd,
        stdin: request.stdin ?? 'closed',
        cols: request.cols,
        rows: request.rows,
      });
    },
    async *attach(handle, commandId, signal) {
      requireGate();
      if (handle.kind !== 'codespaces') throw new Error('Backend handle mismatch: expected codespaces.');
      if (!commandId) throw new Error('Command ID is invalid.');
      const metadata = await loadCodespacesHandleRecord(deps.stateDir, handle);
      const logger = (input: Parameters<typeof recordCodespacesEvent>[1]) => recordCodespacesEvent(deps.stateDir, input);
      yield* attachRemoteCommand({
        stateDir: deps.stateDir, metadata, provider, root: deps.root, config: deps.config,
        spawner: deps.spawner ?? createNodeSshSpawner(), signal, logger,
      }, commandId);
    },
    async cancel(handle, commandId, signal) {
      requireGate();
      if (handle.kind !== 'codespaces') throw new Error('Backend handle mismatch: expected codespaces.');
      if (!commandId) throw new Error('Command ID is invalid.');
      const metadata = await loadCodespacesHandleRecord(deps.stateDir, handle);
      const logger = (input: Parameters<typeof recordCodespacesEvent>[1]) => recordCodespacesEvent(deps.stateDir, input);
      const outcome = await cancelRemoteCommand({
        stateDir: deps.stateDir, metadata, provider, root: deps.root, config: deps.config,
        spawner: deps.spawner ?? createNodeSshSpawner(), signal, logger,
      }, commandId);
      if (outcome.outcome === 'cancel-outcome-unknown') {
        throw new Error(`Cancellation could not be proven for remote command ${commandId}; the process group may still be running remotely. Agent Containers recorded a cancel-outcome-unknown recovery barrier and never claims the command stopped.`);
      }
    },
    async recover() { gated(); },
    async remove() { gated(); },
  };
}

async function loadCodespacesHandleRecord(stateDir: string, handle: Extract<WorkspaceHandle, { kind: 'codespaces' }>): Promise<CodespacesWorkspaceMetadata> {
  const records = await listMetadata(stateDir);
  for (const entry of records) {
    if (entry.version !== 2 || entry.backend !== 'codespaces') continue;
    if (entry.workspaceId === handle.id || entry.remote.name === handle.name || entry.remote.codespaceId === handle.id) return entry;
  }
  throw new Error('No recorded Codespaces workspace matches the exact backend handle; readiness observes only exactly recorded workspaces.');
}

function codespacesCreateOutcomeSummary(outcome: codespacesCreateOutcomeType): string {
  if (outcome.outcome === 'quarantined') return `Codespace recorded but quarantined (${outcome.reason}): ${outcome.summary}`;
  if (outcome.outcome === 'blocked') return `Codespace create was blocked: ${outcome.reason}`;
  return `Codespace create is ambiguous and requires manual recovery (${outcome.reason}). The resource was neither adopted nor deleted; recovery evidence is journaled under the recorded request ID ${outcome.requestId}.`;
}
type codespacesCreateOutcomeType = Exclude<CodespacesCreateOutcome, { outcome: 'recorded' }>;

function requireOperation<T>(operation: T | undefined, name: string): T { if (!operation) throw new Error(`Local ${name} lifecycle is unavailable.`); return operation; }
function assertHandle(handle: WorkspaceHandle, expected: 'local'): void { if (handle.kind !== expected) throw new Error(`Backend handle mismatch: expected ${expected}.`); }
function assertRequestName(request: { name: string; backend: BackendKind }): void { if (request.backend !== 'local' || !request.name || request.name.includes('\0')) throw new Error('Workspace creation request is invalid.'); }
function assertRequest(request: { commandId: string; argv: readonly [string, ...string[]] }): void { if (!request.commandId || !request.argv.length || request.argv.some((value) => !value || value.includes('\0'))) throw new Error('Execution request is invalid.'); }
function assertRemoteRequest(request: RemoteCommandRequest): void {
  if (!request.commandId || !request.argv.length || request.argv.some((value) => !value || value.includes('\0'))) throw new Error('Execution request is invalid.');
  if (request.mode !== undefined && request.mode !== 'pipe' && request.mode !== 'pty') throw new Error('Remote execution mode must be pipe or pty.');
  if (request.cwd !== undefined && (!request.cwd || request.cwd.length > 1024 || /[\0\r\n]/.test(request.cwd))) throw new Error('Remote cwd is invalid.');
}
