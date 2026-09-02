import type { GhCodespacesProvider, CodespacesResource } from './codespaces.js';
import type { CodespacesAgentContainersConfig, DoctorCheck } from './types.js';
import { loadMetadata, type CodespacesWorkspaceMetadata, type WorkspaceMetadata } from './state.js';
import { verifyCodespacesIdentity } from './codespaces-create.js';
import { redactSecretDiagnostic } from './secrets.js';

export type ReadinessGateId =
  | 'create-recorded'
  | 'resource-recorded'
  | 'provider-available'
  | 'readback-facts'
  | 'repository-identity'
  | 'creation-logs'
  | 'ssh-ready'
  | 'runtime-ready';

export type ReadinessGateState = 'passed' | 'blocked' | 'timeout' | 'skipped';
export type ReadinessTerminal = 'ready' | 'ready-without-setup-proof' | 'blocked' | 'timeout' | 'skipped' | 'pending';

export interface ReadinessGateResult { id: ReadinessGateId; state: ReadinessGateState; observedAt: string; detail: string; timeoutMs: number | null }
export interface ReadinessReport {
  terminal: ReadinessTerminal;
  workspaceId: string;
  name: string;
  gates: readonly ReadinessGateResult[];
  startedAt: string;
}

export interface CodespacesReadinessEvent { type: 'readiness'; report: ReadinessReport }

export interface CodespacesReadinessDependencies {
  stateDir: string;
  name: string;
  provider: GhCodespacesProvider;
  config: CodespacesAgentContainersConfig;
  signal?: AbortSignal;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  loadMetadata?: (stateDir: string, name: string) => Promise<WorkspaceMetadata | undefined>;
}

const PROVIDER_POLL_INTERVAL_MS = 250;
const CREATION_LOG_LINE_LIMIT = 200;
const CREATION_LOG_DIAGNOSTIC_BYTES = 2048;
const SSH_IDENTITY_PROBE = 'agent-containers-readiness-probe';
const PROVIDER_AVAILABLE_STATES = new Set(['Running', 'Available']);
const PROVIDER_TERMINAL_BLOCKED_STATES = new Set(['Stopped', 'Shutdown', 'Removing', 'Removed', 'Deleted']);

/**
 * Realize every readiness gate in order. Each gate has its own bound and is
 * reported independently. The terminal state is never `ready` unless setup has
 * completed and repository identity matches the immutable source.
 */
export async function runReadinessProbes(deps: CodespacesReadinessDependencies): Promise<ReadinessReport> {
  let terminal: ReadinessReport | undefined;
  for await (const report of readinessProbeSequence(deps)) terminal = report;
  if (!terminal) throw new Error('Readiness pipeline produced no report.');
  return terminal;
}

export async function* waitCodespacesReady(deps: CodespacesReadinessDependencies): AsyncGenerator<CodespacesReadinessEvent> {
  for await (const report of readinessProbeSequence(deps)) yield { type: 'readiness', report };
}

async function* readinessProbeSequence(deps: CodespacesReadinessDependencies): AsyncGenerator<ReadinessReport> {
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const pipeline = await loadPipeline(deps);
  if (typeof pipeline === 'string') {
    yield { terminal: 'blocked', workspaceId: '', name: deps.name, gates: [{ id: 'create-recorded', state: 'blocked', observedAt: now(), detail: pipeline, timeoutMs: null }], startedAt };
    return;
  }
  if (pipeline === undefined) {
    yield { terminal: 'blocked', workspaceId: '', name: deps.name, gates: [{ id: 'create-recorded', state: 'blocked', observedAt: now(), detail: 'No recorded Codespaces workspace exists; readiness never creates or starts one.', timeoutMs: null }], startedAt };
    return;
  }

  const gates: ReadinessGateResult[] = [];
  const metadata = pipeline.metadata;
  const push = (gate: ReadinessGateResult): void => { gates.push(gate); };
  const report = (terminal: ReadinessTerminal): ReadinessReport => ({ terminal, workspaceId: metadata.workspaceId, name: deps.name, gates: [...gates], startedAt });
  push({ id: 'create-recorded', state: 'passed', observedAt: now(), detail: 'durable create intent was recorded before provider dispatch.', timeoutMs: null });
  yield report('pending');
  push({ id: 'resource-recorded', state: 'passed', observedAt: now(), detail: 'provider Codespaces identity is durably recorded.', timeoutMs: null });
  yield report('pending');

  const providerAvailable = await pollProviderAvailable(deps, metadata, now);
  push(providerAvailable);
  if (deps.signal?.aborted) { yield report('skipped'); return; }
  if (providerAvailable.state !== 'passed') { yield report(providerAvailable.state === 'timeout' ? 'timeout' : 'blocked'); return; }
  yield report('pending');

  const readback = await freshReadback(deps, metadata, now);
  push(readback);
  if (deps.signal?.aborted) { yield report('skipped'); return; }
  if (readback.state !== 'passed') { yield report(readback.state === 'timeout' ? 'timeout' : 'blocked'); return; }
  yield report('pending');

  const repository = await repositoryIdentity(deps, metadata, now);
  push(repository);
  if (repository.state !== 'passed') { yield report('blocked'); return; }
  yield report('pending');

  const logs = await creationLogs(deps, metadata, now);
  push(logs);
  if (logs.state !== 'passed') { yield report('blocked'); return; }
  yield report('pending');

  const ssh = await sshReady(deps, metadata, now);
  push(ssh);
  if (ssh.state !== 'passed') { yield report('blocked'); return; }
  yield report('pending');

  const runtime = await runtimeReady(deps, metadata, now);
  push(runtime);
  if (runtime.state === 'blocked' || runtime.state === 'timeout') { yield report(runtime.state); return; }
  yield report('pending');

  const terminal = deps.config.backends.codespaces.readiness.command.length > 0 ? 'ready' : 'ready-without-setup-proof';
  yield report(terminal);
}

async function loadPipeline(deps: CodespacesReadinessDependencies): Promise<{ metadata: CodespacesWorkspaceMetadata } | undefined | string> {
  const load = deps.loadMetadata ?? loadMetadata;
  let metadata: WorkspaceMetadata | undefined;
  try {
    metadata = await load(deps.stateDir, deps.name) as WorkspaceMetadata | undefined;
  } catch (error: unknown) {
    return `Codespaces workspace metadata for ${deps.name} is unreadable or corrupt; readiness fails closed and never treats corruption as absence (${error instanceof Error ? error.message : String(error)}).`;
  }
  if (!metadata) return undefined;
  if (!(metadata.version === 2 && metadata.backend === 'codespaces')) return `Workspace ${deps.name} does not record the Codespaces backend; readiness only probes exactly recorded Codespaces workspaces.`;
  return { metadata };
}

async function pollProviderAvailable(deps: CodespacesReadinessDependencies, metadata: CodespacesWorkspaceMetadata, now: () => string): Promise<ReadinessGateResult> {
  const timeoutMs = deps.config.backends.codespaces.readiness.providerTimeoutSeconds * 1000;
  const deadlineMs = Date.now() + timeoutMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const observedStates: string[] = [`${metadata.lifecycle.providerRawState} (recorded)`];
  let unreachableDiagnostic: string | null = null;
  for (;;) {
    if (deps.signal?.aborted) return { id: 'provider-available', state: 'skipped', observedAt: now(), detail: 'provider polling was cancelled.', timeoutMs };
    let resource: CodespacesResource;
    try {
      resource = await deps.provider.get(metadata.remote.name);
    } catch {
      if (Date.now() >= deadlineMs) return { id: 'provider-available', state: 'timeout', observedAt: now(), detail: unreachableDiagnostic ?? `provider state could not be observed within ${deps.config.backends.codespaces.readiness.providerTimeoutSeconds}s.`, timeoutMs };
      unreachableDiagnostic = `provider state could not be observed within ${deps.config.backends.codespaces.readiness.providerTimeoutSeconds}s.`;
      await sleep(Math.min(PROVIDER_POLL_INTERVAL_MS, Math.max(1, deadlineMs - Date.now())));
      continue;
    }
    observedStates.push(resource.state);
    if (PROVIDER_TERMINAL_BLOCKED_STATES.has(resource.state)) {
      return { id: 'provider-available', state: 'blocked', observedAt: now(), detail: `provider reported terminal state ${resource.state}; read-only diagnosis cannot reach ready and nothing is restarted.`, timeoutMs };
    }
    if (PROVIDER_AVAILABLE_STATES.has(resource.state)) return { id: 'provider-available', state: 'passed', observedAt: now(), detail: `provider state ${resource.state} is available.`, timeoutMs };
    if (Date.now() >= deadlineMs) return { id: 'provider-available', state: 'timeout', observedAt: now(), detail: `provider state never reached an available state within ${deps.config.backends.codespaces.readiness.providerTimeoutSeconds}s; last observed ${observedStates.at(-1)}.`, timeoutMs };
    await sleep(Math.min(PROVIDER_POLL_INTERVAL_MS, Math.max(1, deadlineMs - Date.now())));
  }
}

async function freshReadback(deps: CodespacesReadinessDependencies, metadata: CodespacesWorkspaceMetadata, now: () => string): Promise<ReadinessGateResult> {
  const timeoutMs = deps.config.backends.codespaces.readiness.providerTimeoutSeconds * 1000;
  let readback: CodespacesResource;
  try {
    readback = await deps.provider.get(metadata.remote.name);
  } catch {
    return { id: 'readback-facts', state: 'timeout', observedAt: now(), detail: 'readback GET did not return a confirmable identity.', timeoutMs };
  }
  const verification = verifyCodespacesIdentity(metadata, readback);
  if (!verification.ok) return { id: 'readback-facts', state: 'blocked', observedAt: now(), detail: `readback identity mismatch: ${verification.mismatches.join(', ')}.`, timeoutMs };
  if (readback.devcontainerPath !== metadata.source.devcontainerPath) return { id: 'readback-facts', state: 'blocked', observedAt: now(), detail: `readback devcontainer_path ${readback.devcontainerPath} does not match the recorded committed path ${metadata.source.devcontainerPath}.`, timeoutMs };
  return { id: 'readback-facts', state: 'passed', observedAt: now(), detail: 'readback facts match the recorded immutable identity.', timeoutMs };
}

async function repositoryIdentity(deps: CodespacesReadinessDependencies, metadata: CodespacesWorkspaceMetadata, now: () => string): Promise<ReadinessGateResult> {
  const timeoutMs = deps.config.backends.codespaces.readiness.sshTimeoutSeconds * 1000;
  const workspaceRoot = repositoryWorkspaceRoot(metadata);
  const probes = [
    ['git', '-C', workspaceRoot, 'rev-parse', '--show-toplevel'],
    ['git', '-C', workspaceRoot, 'rev-parse', 'HEAD'],
    ['git', '-C', workspaceRoot, 'remote', 'get-url', 'origin'],
  ];
  const values: string[] = [];
  for (const argv of probes) {
    let output: string;
    try {
      output = await deps.provider.remoteSshProbe(metadata.remote.name, argv as [string, ...string[]], { timeoutMs, signal: deps.signal });
    } catch (error: unknown) {
      return { id: 'repository-identity', state: 'blocked', observedAt: now(), detail: `SSH transport could not run the fixed repository identity probe (${redactSecretDiagnostic(error instanceof Error ? error.message : String(error))}); no repository mutation was attempted.`, timeoutMs };
    }
    values.push(output.trim());
  }
  const mismatch: string[] = [];
  if (values[0] !== workspaceRoot) mismatch.push(`root ${values[0]}`);
  if (values[1] !== metadata.source.expectedOid) mismatch.push(`HEAD ${values[1]}`);
  if (!canonicalRemoteMatches(values[2], metadata.repository)) mismatch.push(`remote ${values[2]}`);
  if (mismatch.length > 0) return { id: 'repository-identity', state: 'blocked', observedAt: now(), detail: `fixed repository identity probe reported ${mismatch.join(', ')}.`, timeoutMs };
  return { id: 'repository-identity', state: 'passed', observedAt: now(), detail: 'repository root, HEAD, and origin match the immutable record.', timeoutMs };
}

async function creationLogs(deps: CodespacesReadinessDependencies, metadata: CodespacesWorkspaceMetadata, now: () => string): Promise<ReadinessGateResult> {
  const timeoutMs = deps.config.backends.codespaces.readiness.providerTimeoutSeconds * 1000;
  let output: string;
  try {
    output = await deps.provider.creationLogs(metadata.remote.name, CREATION_LOG_LINE_LIMIT);
  } catch (error: unknown) {
    return { id: 'creation-logs', state: 'blocked', observedAt: now(), detail: `bounded creation logs could not be read (${redactSecretDiagnostic(error instanceof Error ? error.message : String(error))}); this is diagnostic only.`, timeoutMs };
  }
  const tail = redactSecretDiagnostic(output).slice(-CREATION_LOG_DIAGNOSTIC_BYTES);
  return { id: 'creation-logs', state: 'passed', observedAt: now(), detail: tail, timeoutMs };
}

async function sshReady(deps: CodespacesReadinessDependencies, metadata: CodespacesWorkspaceMetadata, now: () => string): Promise<ReadinessGateResult> {
  const timeoutMs = deps.config.backends.codespaces.readiness.sshTimeoutSeconds * 1000;
  try {
    const output = await deps.provider.remoteSshProbe(metadata.remote.name, ['printf', '%s', SSH_IDENTITY_PROBE], { timeoutMs, signal: deps.signal });
    if (output.trim() !== SSH_IDENTITY_PROBE) return { id: 'ssh-ready', state: 'blocked', observedAt: now(), detail: 'SSH probe completed but did not echo the fixed probe; transport is unusable.', timeoutMs };
  } catch {
    return { id: 'ssh-ready', state: 'blocked', observedAt: now(), detail: 'SSHD appears absent or the exact recorded Codespace is unreachable; Agent Containers does not install SSHD and performs no repository mutations.', timeoutMs };
  }
  return { id: 'ssh-ready', state: 'passed', observedAt: now(), detail: 'fixed SSH probe succeeded; SSHD is reachable.', timeoutMs };
}

async function runtimeReady(deps: CodespacesReadinessDependencies, metadata: CodespacesWorkspaceMetadata, now: () => string): Promise<ReadinessGateResult> {
  const command = deps.config.backends.codespaces.readiness.command;
  if (command.length === 0) return { id: 'runtime-ready', state: 'skipped', observedAt: now(), detail: 'no post-create readiness argv is configured; repository lifecycle scripts may still be running.', timeoutMs: null };
  const timeoutMs = deps.config.backends.codespaces.readiness.commandTimeoutSeconds * 1000;
  try {
    await deps.provider.remoteSshProbe(metadata.remote.name, [...command] as [string, ...string[]], { timeoutMs, signal: deps.signal });
  } catch (error: unknown) {
    return { id: 'runtime-ready', state: 'blocked', observedAt: now(), detail: `configured readiness argv did not succeed (${redactSecretDiagnostic(error instanceof Error ? error.message : String(error))}).`, timeoutMs };
  }
  return { id: 'runtime-ready', state: 'passed', observedAt: now(), detail: 'configured post-create readiness argv succeeded.', timeoutMs };
}

function repositoryWorkspaceRoot(metadata: CodespacesWorkspaceMetadata): string {
  return `/workspaces/${metadata.repository.name}`;
}

function canonicalRemoteMatches(remote: string, repository: CodespacesWorkspaceMetadata['repository']): boolean {
  const value = remote.trim();
  return new RegExp(`^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${repository.owner}/${repository.name}(?:\\.git)?$`, 'i').test(value);
}

/** Stable, deterministic provisioned-runtime checks for doctor built from the same bounded probes. */
export function readinessGateDoctorChecks(metadata: CodespacesWorkspaceMetadata, report: ReadinessReport): readonly DoctorCheck[] {
  const mapping: Array<[ReadinessGateId, string]> = [
    ['provider-available', 'codespaces.runtime.provider'],
    ['readback-facts', 'codespaces.runtime.readback'],
    ['repository-identity', 'codespaces.runtime.repository'],
    ['creation-logs', 'codespaces.runtime.creation-logs'],
    ['ssh-ready', 'codespaces.runtime.ssh'],
    ['runtime-ready', 'codespaces.runtime.readiness-command'],
  ];
  return mapping.map(([gateId, checkId]) => {
    const gate = report.gates.find((entry) => entry.id === gateId);
    if (!gate) return { id: checkId, backend: 'codespaces', phase: 'provisioned-runtime', state: 'action-required', summary: `${gateId} was not independently reached by the bounded readiness probes.`, remediation: [`Run ac doctor --backend codespaces --workspace ${metadata.name}.`] };
    if (gate.state === 'skipped') return { id: checkId, backend: 'codespaces', phase: 'provisioned-runtime', state: 'ready', summary: `${gate.id}: skipped because no post-create proof is configured.`, remediation: [] };
    if (gate.state === 'passed') return { id: checkId, backend: 'codespaces', phase: 'provisioned-runtime', state: 'ready', summary: `${gate.id}: ${gate.detail}`, remediation: [] };
    const unsupported = gateId === 'ssh-ready' && /SSHD appears absent|unreachable/.test(gate.detail);
    const state = unsupported ? 'unsupported' : 'action-required';
    const remediation = unsupported
      ? ['Add a reachable SSH server to the committed Dev Container image.', `Run ac doctor --backend codespaces --workspace ${metadata.name} again.`]
      : [gate.detail, `Run ac doctor --backend codespaces --workspace ${metadata.name} again.`];
    return { id: checkId, backend: 'codespaces', phase: 'provisioned-runtime', state, summary: `${gate.id}: ${gate.detail}`, remediation };
  });
}