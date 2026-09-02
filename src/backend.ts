import type { CommandEvent, ExecutionBackend, WorkspaceHandle, WorkspaceObservation } from './types.js';
import type { BackendKind } from './types.js';

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
function requireOperation<T>(operation: T | undefined, name: string): T { if (!operation) throw new Error(`Local ${name} lifecycle is unavailable.`); return operation; }
function assertHandle(handle: WorkspaceHandle, expected: 'local'): void { if (handle.kind !== expected) throw new Error(`Backend handle mismatch: expected ${expected}.`); }
function assertRequestName(request: { name: string; backend: BackendKind }): void { if (request.backend !== 'local' || !request.name || request.name.includes('\0')) throw new Error('Workspace creation request is invalid.'); }
function assertRequest(request: { commandId: string; argv: readonly [string, ...string[]] }): void { if (!request.commandId || !request.argv.length || request.argv.some((value) => !value || value.includes('\0'))) throw new Error('Execution request is invalid.'); }
