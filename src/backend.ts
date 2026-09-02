import type { BackendKind, ExecutionBackend, WorkspaceHandle } from './types.js';

/** Resolve only known backends. Codespaces lifecycle is deliberately unavailable in this phase. */
export function resolveExecutionBackend(kind: BackendKind): ExecutionBackend {
  return kind === 'local' ? localBackend : codespacesGate;
}

export function assertBackendAvailable(kind: BackendKind): void {
  if (resolveExecutionBackend(kind).kind === 'codespaces') gated();
}

const localBackend: ExecutionBackend = {
  kind: 'local',
  async create() { throw new Error('Local workspace creation is dispatched by the local worktree lifecycle.'); },
  async observe(handle) { assertHandle(handle, 'local'); return { backend: 'local', state: 'recorded', observedAt: new Date().toISOString() }; },
  async *waitReady(handle) { assertHandle(handle, 'local'); yield { backend: 'local', state: 'recorded', observedAt: new Date().toISOString() }; },
  async *execute(handle, request) { assertHandle(handle, 'local'); assertRequest(request); yield* []; throw new Error('Local execution is dispatched by the local Dev Containers lifecycle.'); },
  async *attach(handle) { assertHandle(handle, 'local'); yield* []; throw new Error('Local command attachment is not available.'); },
  async cancel(handle) { assertHandle(handle, 'local'); throw new Error('Local command cancellation is dispatched by the local process lifecycle.'); },
  async recover(handle) { assertHandle(handle, 'local'); throw new Error('Local recovery is dispatched by the local lifecycle.'); },
  async remove(handle) { assertHandle(handle, 'local'); throw new Error('Local removal is dispatched by the local worktree lifecycle.'); },
};

const codespacesGate: ExecutionBackend = {
  kind: 'codespaces',
  async create() { gated(); }, async observe() { gated(); }, async *waitReady() { yield* []; gated(); }, async *execute() { yield* []; gated(); }, async *attach() { yield* []; gated(); }, async cancel() { gated(); }, async recover() { gated(); }, async remove() { gated(); },
};
function gated(): never { throw new Error('Codespaces lifecycle is phase-gated and unavailable in this release.'); }
function assertHandle(handle: WorkspaceHandle, expected: 'local'): void { if (handle.kind !== expected) throw new Error(`Backend handle mismatch: expected ${expected}.`); }
function assertRequest(request: { commandId: string; argv: readonly [string, ...string[]] }): void { if (!request.commandId || !request.argv.length || request.argv.some((value) => !value || value.includes('\0'))) throw new Error('Execution request is invalid.'); }
