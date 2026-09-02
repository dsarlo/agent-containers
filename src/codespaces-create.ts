import { randomUUID } from 'node:crypto';
import type { CodespacesAgentContainersConfig } from './types.js';
import type { ProcessRunner } from './types.js';
import type { CodespacesResource, GithubActor, GhCodespacesProvider } from './codespaces.js';
import {
  type CodespacesCreateIntent, type CodespacesRecoveryReason, loadCreateIntent, listCreateIntents, recordCodespacesEvent, recordCreateIntent, updateCreateIntent,
} from './codespaces-ops.js';
import { canReserveCreate, capacityReport, categorizeCreateIntent, categorizeWorkspace, withGlobalCapacityLock, type CapacityPolicy } from './codespaces-capacity.js';
import { listMetadata, loadMetadata, metadataGeneration, saveMetadata, type CodespacesWorkspaceMetadata, type MetadataSaveOptions } from './state.js';

export type CodespacesCreateOutcome =
  | { outcome: 'recorded'; requestId: string; metadata: CodespacesWorkspaceMetadata }
  | { outcome: 'quarantined'; requestId: string; metadata: CodespacesWorkspaceMetadata; reason: CodespacesRecoveryReason; summary: string }
  | { outcome: 'blocked'; requestId: string; reason: string }
  | { outcome: 'ambiguous'; requestId: string; reason: CodespacesRecoveryReason; recovery: CodespacesCreateRecoveryReport };

export interface CodespacesCreateRecoveryReport {
  requestId: string;
  name: string;
  reason: CodespacesRecoveryReason;
  createdAt: string;
  control: CodespacesCreateIntent['control'];
  repository: CodespacesCreateIntent['repository'];
  source: CodespacesCreateIntent['source'];
  capacity: CodespacesCreateIntent['capacity'];
  providerCorrelationId: string | null;
  providerError: string | null;
  observedRemoteState: string | null;
  /** Read-only candidate diagnostics; never adopted or deleted by any recovery path. */
  candidates: ReadonlyArray<{ id: string; name: string; state: string }>;
}

export type CapacityCategory = 'creating' | 'running' | 'stopped' | 'uncertain';
export interface CapacityCountedWorkspace { name: string; category: CapacityCategory }

export interface CodespacesCreateDependencies {
  stateDir: string;
  requestId: string;
  name: string;
  config: CodespacesAgentContainersConfig;
  root: string;
  runner: ProcessRunner;
  provider: GhCodespacesProvider;
  signal?: AbortSignal;
  now?: () => string;
  saveMetadata?: (stateDir: string, metadata: CodespacesWorkspaceMetadata, options: MetadataSaveOptions) => Promise<void>;
  loadMetadata?: (stateDir: string, name: string) => Promise<CodespacesWorkspaceMetadata | undefined>;
  ghVersion: string;
  displayNameHint?: string | null;
}

export interface CodespacesPreflightFacts {
  actor: GithubActor;
  repository: { id: string; owner: string; name: string };
  requestedRef: string;
  expectedOid: string;
  devcontainerPath: string;
  devcontainerBlobOid: string;
  effectiveBranch: string;
}

/**
 * Resolve an immutable OID from the verified remote-tracking branch ref. This
 * never reads a moving branch head: `refs/remotes/origin/<branch>^{commit}` is
 * the durable, reviewed snapshot that binds `expectedOid`.
 */
export async function resolveLocalRemoteRefOid(runner: ProcessRunner, root: string, requestedRef: string, expectedOid?: string): Promise<void> {
  const branch = remoteTrackingBranch(requestedRef);
  if (!branch) throw new Error(`Codespaces create requires a branch under refs/heads/ that binds to refs/remotes/origin/<branch>; got ${requestedRef}.`);
  const result = await runner.run('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], { cwd: root, kind: 'readonly-probe' });
  const oid = result.code === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
  if (!oid) throw new Error(`Could not bind configured ref ${requestedRef} to an immutable remote-tracking OID; run git fetch origin and retry.`);
  if (expectedOid !== undefined && oid !== expectedOid) {
    throw new Error(`Local remote-tracking ref refs/remotes/origin/${branch} does not match the recorded immutable OID ${expectedOid}; review or re-fetch before creating a Codespace.`);
  }
}

function remoteTrackingBranch(requestedRef: string): string | undefined {
  const match = /^refs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(requestedRef);
  if (!match || match[1].includes('..') || match[1].split('/').some((part) => part.endsWith('.') || part.endsWith('.lock'))) return undefined;
  return match[1];
}

/**
 * Repeat the critical preflight facts independently of any prior doctor run:
 * actor identity, repository identity, remote-ref resolution, and committed
 * Dev Container blob verification against the exact immutable Git tree.
 */
export async function preflightCodespacesCreate(deps: CodespacesCreateDependencies, config: CodespacesAgentContainersConfig): Promise<CodespacesPreflightFacts> {
  const requestedRef = config.project.ref;
  const repository = config.project.repository;
  const devcontainerPath = config.environment.devcontainerPath;
  if (config.version !== 2 || !config.backends.enabled.includes('codespaces') || !requestedRef || !repository) throw new Error('Codespaces create requires an explicit repository and remotely resolvable ref.');
  if (!config.backends.codespaces.machine) throw new Error('A Codespaces machine must be explicitly selected before creation; Agent Containers never chooses a paid machine.');
  const actor = await deps.provider.actor();
  const repoRecord = await deps.provider.repositoryRecord(repository);
  const apiOid = await deps.provider.resolveRef(repository, requestedRef);
  if (config.project.expectedOid && apiOid !== config.project.expectedOid) {
    throw new Error(`Remote ref ${requestedRef} moved since configuration: expected ${config.project.expectedOid} but resolves to ${apiOid}; review a fresh immutable OID before creating a Codespace.`);
  }
  await resolveLocalRemoteRefOid(deps.runner, deps.root, requestedRef, config.project.expectedOid ?? apiOid);
  const devcontainerBlobOid = await deps.provider.committedDevcontainerBlob(repository, apiOid, devcontainerPath);
  if (config.environment.devcontainerBlobOid && devcontainerBlobOid !== config.environment.devcontainerBlobOid) {
    throw new Error('Configured Dev Container blob drifted from the immutable Git tree; review fresh source evidence before creating a Codespace.');
  }
  return { actor, repository: repoRecord, requestedRef, expectedOid: apiOid, devcontainerPath, devcontainerBlobOid, effectiveBranch: `agent-containers/${deps.name}` };
}

/**
 * Exact create/no-adoption: resolve immutable OID, durably record intent,
 * dispatch the documented create endpoint, persist the exact response, perform
 * an exact GET readback, and enforce identity before any further action.
 */
export async function createCodespacesWorkspace(deps: CodespacesCreateDependencies): Promise<CodespacesCreateOutcome> {
  const config = deps.config;
  if (config.version !== 2) throw new Error('Codespaces create requires schema-v2 configuration.');
  if (!config.backends.codespaces.machine) throw new Error('A Codespaces machine must be explicitly selected before creation; no fallback machine exists.');
  const now = deps.now ?? (() => new Date().toISOString());
  const operationId = randomUUID();

  let preflight: CodespacesPreflightFacts;
  try {
    preflight = await preflightCodespacesCreate(deps, config);
  } catch (error: unknown) {
    return { outcome: 'blocked', requestId: deps.requestId, reason: error instanceof Error ? error.message : String(error) };
  }

  const policy: CapacityPolicy = { maxCreating: config.backends.codespaces.maxCreating, maxRunning: config.backends.codespaces.maxRunning, maxTotal: config.backends.codespaces.maxTotal };
  let ambiguous: CodespacesCreateOutcome | undefined;
  let reservedIntent: CodespacesCreateIntent | undefined;
  await withGlobalCapacityLock({ stateDir: deps.stateDir, policy, signal: deps.signal, sample: () => sampleCapacity(deps.stateDir) }, async () => {
    const report = capacityReport(await sampleCapacity(deps.stateDir), policy);
    if (!canReserveCreate(report)) {
      ambiguous = { outcome: 'blocked', requestId: deps.requestId, reason: `Codespaces capacity is exhausted (${report.blockers.join('; ') || 'configured limits reached'}).` };
      return;
    }
    const intent = buildIntent(deps, preflight, config, now);
    try {
      await recordCreateIntent(deps.stateDir, intent, { expectAbsent: true });
    } catch (error: unknown) {
      if (error instanceof Error && /duplicate local request ID/i.test(error.message)) {
        ambiguous = {
          outcome: 'ambiguous',
          requestId: deps.requestId,
          reason: 'duplicate-request-id',
          recovery: {
            requestId: deps.requestId, name: deps.name, reason: 'duplicate-request-id', createdAt: intent.createdAt,
            control: intent.control, repository: preflight.repository, source: { requestedRef: preflight.requestedRef, expectedOid: preflight.expectedOid, devcontainerPath: preflight.devcontainerPath, devcontainerBlobOid: preflight.devcontainerBlobOid },
            capacity: intent.capacity, providerCorrelationId: null, providerError: 'A create intent with this request ID is already recorded; the provider was never called again.', observedRemoteState: null, candidates: [],
          },
        };
        return;
      }
      throw error;
    }
    reservedIntent = intent;
    await recordCodespacesEvent(deps.stateDir, { event: 'operation-created', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: intent.control.actorId, repositoryId: intent.repository.id, codespaceId: null, previous: null, next: 'create-intent', detail: null });
  });
  if (ambiguous) return ambiguous;
  assertIntent(reservedIntent);

  try {
    const outcome = await dispatchCreate(deps, preflight, config, reservedIntent, operationId, now);
    return outcome;
  } catch (error: unknown) {
    const reason = classifyCreateAmbiguity(error);
    const current = (await loadCreateIntent(deps.stateDir, deps.requestId)) ?? reservedIntent;
    await journalAmbiguousCreate(deps, preflight, config, current, operationId, now, reason, error);
    return await buildRecoveryOutcome(deps, preflight, config, current, reason, error);
  }
}

async function dispatchCreate(deps: CodespacesCreateDependencies, preflight: CodespacesPreflightFacts, config: CodespacesAgentContainersConfig, intent: CodespacesCreateIntent, operationId: string, now: () => string): Promise<CodespacesCreateOutcome> {
  await updateCreateIntent(deps.stateDir, { ...intent, state: 'create-dispatched' as const, updatedAt: now() }, { expectedState: 'intent-recorded' });
  await recordCodespacesEvent(deps.stateDir, { event: 'provider-request-dispatched', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: intent.control.actorId, repositoryId: intent.repository.id, codespaceId: null, previous: 'intent-recorded', next: 'create-dispatched', detail: null });

  const resource = await deps.provider.create({
    repositoryId: preflight.repository.id,
    ref: preflight.requestedRef,
    devcontainerPath: preflight.devcontainerPath,
    machine: explicitMachine(config),
    idleTimeoutMinutes: config.backends.codespaces.idleTimeoutMinutes,
    retentionPeriodMinutes: config.backends.codespaces.retentionPeriodMinutes,
    geo: config.backends.codespaces.geo === 'auto' ? undefined : config.backends.codespaces.geo,
    displayName: deps.displayNameHint ?? undefined,
  });

  const recorded = { ...intent, state: 'resource-recorded' as const, providerResource: resource, updatedAt: now() };
  await updateCreateIntent(deps.stateDir, recorded, { expectedState: 'create-dispatched' });
  await recordCodespacesEvent(deps.stateDir, { event: 'provider-response-recorded', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: intent.control.actorId, repositoryId: intent.repository.id, codespaceId: resource.id, previous: 'create-dispatched', next: 'resource-recorded', detail: null });

  const metadata = buildMetadata(deps, preflight, resource, operationId, now);
  await persistMetadata(deps, metadata);

  let currentActor: GithubActor;
  try {
    currentActor = await deps.provider.actor();
  } catch {
    return await quarantine(deps, preflight, resource, operationId, now, metadata, 'identity-mismatch', 'Could not re-verify the authenticated GitHub actor after creation; the recorded Codespace is quarantined.');
  }
  if (currentActor.id !== preflight.actor.id) {
    return await quarantine(deps, preflight, resource, operationId, now, metadata, 'actor-changed', `Authenticated GitHub actor changed from ${preflight.actor.id} to ${currentActor.id} after creation; the recorded Codespace is quarantined.`);
  }

  const readbackResult = await (async () => {
    try { return await deps.provider.get(resource.name); }
    catch { return null; }
  })();
  if (readbackResult === null) {
    return await quarantine(deps, preflight, resource, operationId, now, metadata, 'identity-mismatch', `GET readback of the created Codespace ${resource.name} did not return a confirmable identity; the recorded Codespace is quarantined.`);
  }
  const readback = readbackResult;

  const verification = verifyCodespacesIdentity(metadata, readback);
  if (verification.reason === 'revision-mismatch' || !verification.ok) {
    const reason = verification.reason;
    return await quarantine(deps, preflight, resource, operationId, now, metadata, reason, `Readback identity mismatch: ${verification.mismatches.join(', ')}. The recorded Codespace is quarantined; no task command runs and nothing is deleted.`);
  }

  const identical = verifyIdenticalResources(resource, readback);
  if (!identical.ok) {
    return await quarantine(deps, preflight, resource, operationId, now, metadata, 'identity-mismatch', `Create response and GET readback disagree (${identical.mismatches.join(', ')}); the recorded Codespace is quarantined.`);
  }

  const verified = { ...metadata, lifecycle: { ...metadata.lifecycle, normalized: 'provisioning', providerRawState: readback.state, lastObservedAt: now(), activeOperation: { ...(metadata.lifecycle.activeOperation as NonNullable<CodespacesWorkspaceMetadata['lifecycle']['activeOperation']>), checkpoint: 'identity-verified' } } };
  await persistMetadata(deps, verified, metadata);
  await updateCreateIntent(deps.stateDir, { ...intent, state: 'identity-verified' as const, providerResource: resource, updatedAt: now() }, { expectedState: 'resource-recorded' });
  await recordCodespacesEvent(deps.stateDir, { event: 'identity-verified', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: intent.control.actorId, repositoryId: intent.repository.id, codespaceId: resource.id, previous: 'resource-recorded', next: 'identity-verified', detail: null });
  return { outcome: 'recorded', requestId: deps.requestId, metadata: verified };
}

async function quarantine(deps: CodespacesCreateDependencies, preflight: CodespacesPreflightFacts, resource: CodespacesResource, operationId: string, now: () => string, metadata: CodespacesWorkspaceMetadata, reason: CodespacesRecoveryReason, summary: string): Promise<CodespacesCreateOutcome> {
  const normalized = reason === 'revision-mismatch' ? 'revision-mismatch' : 'identity-mismatch';
  const quarantined = { ...metadata, lifecycle: { ...metadata.lifecycle, normalized, providerRawState: resource.state, lastObservedAt: now(), activeOperation: { ...(metadata.lifecycle.activeOperation as NonNullable<CodespacesWorkspaceMetadata['lifecycle']['activeOperation']>), checkpoint: 'identity-mismatch' } } };
  await persistMetadata(deps, quarantined, metadata);
  await recordCodespacesEvent(deps.stateDir, { event: 'identity-mismatch', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: preflight.actor.id, repositoryId: preflight.repository.id, codespaceId: resource.id, previous: 'resource-recorded', next: normalized, detail: null });
  await recordCodespacesEvent(deps.stateDir, { event: 'recovery-set', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: preflight.actor.id, repositoryId: preflight.repository.id, codespaceId: resource.id, previous: normalized, next: 'recovery-required', detail: null });
  const intent = await requireIntent(deps.stateDir, deps.requestId);
  await updateCreateIntent(deps.stateDir, { ...intent, state: (reason === 'revision-mismatch' ? 'revision-mismatch' : 'identity-mismatch') as CodespacesCreateIntent['state'], recoveryContext: { reason, recordedAt: now(), observedRemoteState: resource.state }, updatedAt: now() }, { expectedState: 'resource-recorded' });
  return { outcome: 'quarantined', requestId: deps.requestId, metadata: quarantined, reason, summary };
}

async function journalAmbiguousCreate(deps: CodespacesCreateDependencies, preflight: CodespacesPreflightFacts, config: CodespacesAgentContainersConfig, intent: CodespacesCreateIntent, operationId: string, now: () => string, reason: CodespacesRecoveryReason, error: unknown): Promise<void> {
  const detail = redactedDetail(error);
  await updateCreateIntent(deps.stateDir, { ...intent, state: 'ambiguous-create', providerError: detail, recoveryContext: { reason, recordedAt: now(), observedRemoteState: null }, updatedAt: now() }, { expectedState: intent.state });
  await recordCodespacesEvent(deps.stateDir, { event: 'ambiguous-create', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: preflight.actor.id, repositoryId: preflight.repository.id, codespaceId: intent.providerResource?.id ?? null, previous: intent.state, next: 'ambiguous-create', detail });
  await recordCodespacesEvent(deps.stateDir, { event: 'recovery-set', workspaceName: deps.name, operationId, requestId: deps.requestId, actorId: preflight.actor.id, repositoryId: preflight.repository.id, codespaceId: null, previous: 'ambiguous-create', next: 'recovery-required', detail: null });
  void config;
}

async function buildRecoveryOutcome(deps: CodespacesCreateDependencies, preflight: CodespacesPreflightFacts, config: CodespacesAgentContainersConfig, intent: CodespacesCreateIntent, reason: CodespacesRecoveryReason, error: unknown): Promise<CodespacesCreateOutcome> {
  const candidates = await listCandidatesReadonly(deps, preflight.repository.id);
  return {
    outcome: 'ambiguous',
    requestId: deps.requestId,
    reason,
    recovery: {
      requestId: deps.requestId,
      name: deps.name,
      reason,
      createdAt: intent.createdAt,
      control: intent.control,
      repository: preflight.repository,
      source: preflight,
      capacity: intent.capacity,
      providerCorrelationId: intent.providerCorrelationId,
      providerError: redactedDetail(error),
      observedRemoteState: null,
      candidates,
    },
  };
}

async function listCandidatesReadonly(deps: CodespacesCreateDependencies, repositoryId: string): Promise<ReadonlyArray<{ id: string; name: string; state: string }>> {
  try {
    return await deps.provider.listCandidates(repositoryId);
  } catch { return []; }
}

function buildIntent(deps: CodespacesCreateDependencies, preflight: CodespacesPreflightFacts, config: CodespacesAgentContainersConfig, now: () => string): CodespacesCreateIntent {
  return {
    schemaVersion: 1,
    requestId: deps.requestId,
    name: deps.name,
    createdAt: now(),
    control: { githubHost: 'github.com', actorId: preflight.actor.id, actorLogin: preflight.actor.login, ghVersion: deps.ghVersion },
    repository: preflight.repository,
    source: { requestedRef: preflight.requestedRef, expectedOid: preflight.expectedOid, devcontainerPath: preflight.devcontainerPath, devcontainerBlobOid: preflight.devcontainerBlobOid },
    capacity: { machine: explicitMachine(config), geo: config.backends.codespaces.geo === 'auto' ? null : config.backends.codespaces.geo, idleTimeoutMinutes: config.backends.codespaces.idleTimeoutMinutes, retentionPeriodMinutes: config.backends.codespaces.retentionPeriodMinutes, displayNameHint: deps.displayNameHint ?? null },
    state: 'intent-recorded',
    providerCorrelationId: null,
    providerError: null,
    providerResource: null,
    updatedAt: now(),
    recoveryContext: null,
  };
}

function explicitMachine(config: CodespacesAgentContainersConfig): string {
  const machine = config.backends.codespaces.machine;
  if (!machine) throw new Error('A Codespaces machine must be explicitly selected before creation; no fallback machine exists.');
  return machine;
}

function buildMetadata(deps: CodespacesCreateDependencies, preflight: CodespacesPreflightFacts, resource: CodespacesResource, operationId: string, now: () => string): CodespacesWorkspaceMetadata {
  return {
    version: 2, backend: 'codespaces', name: deps.name, workspaceId: randomUUID(), createdAt: now(),
    control: { githubHost: 'github.com', actorId: preflight.actor.id, actorLogin: preflight.actor.login, ghVersion: deps.ghVersion },
    repository: preflight.repository,
    source: { requestedRef: preflight.requestedRef, expectedOid: preflight.expectedOid, effectiveBranch: preflight.effectiveBranch, devcontainerPath: preflight.devcontainerPath, devcontainerBlobOid: preflight.devcontainerBlobOid },
    remote: { codespaceId: resource.id, name: resource.name, environmentId: resource.environmentId, ownerId: resource.owner.id, ownerLogin: resource.owner.login, billableOwnerId: resource.billingOwner.id, machine: resource.machineName, geo: resource.geo ?? resource.location, createdAt: resource.createdAt },
    lifecycle: { desired: 'ready', normalized: 'provisioning', providerRawState: resource.state, lastObservedAt: now(), activeOperation: { id: operationId, kind: 'create', startedAt: now(), checkpoint: 'resource-recorded' } },
    recovery: null,
    cleanup: { remoteStopped: false, remoteDeleted: false, tombstoneWritten: false },
  };
}

async function persistMetadata(deps: CodespacesCreateDependencies, next: CodespacesWorkspaceMetadata, previous?: CodespacesWorkspaceMetadata): Promise<void> {
  const save = deps.saveMetadata ?? saveMetadata;
  if (!previous) {
    await save(deps.stateDir, next, { expectedGeneration: null });
    return;
  }
  const current = await (deps.loadMetadata ?? loadMetadata)(deps.stateDir, deps.name);
  const expected = current !== undefined ? metadataGeneration(current) : metadataGeneration(previous);
  await save(deps.stateDir, next, { expectedGeneration: expected });
}

function classifyCreateAmbiguity(error: unknown): CodespacesRecoveryReason {
  if (error instanceof Error && error.name === 'AbortError') return 'provider-timeout-before-dispatch';
  const detail = error instanceof Error ? error.message : String(error);
  if (/tim(e|ed)? ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(detail)) return 'provider-timeout-after-creation-possible';
  if (/billing|policy|machine|402|403|422/i.test(detail)) return 'billing-policy-machine-rejected';
  return 'create-response-truncated-or-invalid';
}

function redactedDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[credential redacted]').slice(0, 512);
}

async function requireIntent(stateDir: string, requestId: string): Promise<CodespacesCreateIntent> {
  const intent = await loadCreateIntent(stateDir, requestId);
  if (!intent) throw new Error(`Codespaces create intent ${requestId} is missing after publication; refusing to continue without a durable record.`);
  return intent;
}

function assertIntent(intent: CodespacesCreateIntent | undefined): asserts intent is CodespacesCreateIntent {
  if (!intent) throw new Error('Codespaces create intent was not durably recorded before dispatch; refusing to call the provider.');
}

/** Read durable metadata and create intents into conservative capacity categories. */
export async function sampleCapacity(stateDir: string): Promise<CapacityCountedWorkspace[]> {
  const byName = new Map<string, CapacityCategory>();
  const metadata = await listMetadata(stateDir);
  for (const entry of metadata) {
    if (!(entry.version === 2 && entry.backend === 'codespaces')) continue;
    const category = categorizeWorkspace(entry);
    if (category) byName.set(entry.name, category);
  }
  const intents = await listCreateIntents(stateDir);
  for (const summary of intents) {
    if (byName.has(summary.name)) continue;
    const category = categorizeCreateIntent(summary.state);
    if (category) byName.set(summary.name, category);
  }
  return [...byName.entries()].map(([name, category]) => ({ name, category }));
}

/** Compare the two exact provider identity observations; every common field must match. */
export function verifyIdenticalResources(left: CodespacesResource, right: CodespacesResource): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const check = (label: string, leftValue: string | number | null, rightValue: string | number | null): void => {
    if (String(leftValue) !== String(rightValue)) mismatches.push(label);
  };
  check('id', left.id, right.id);
  check('name', left.name, right.name);
  check('environment_id', left.environmentId, right.environmentId);
  check('owner', left.owner.id, right.owner.id);
  check('repository_id', left.repositoryId, right.repositoryId);
  check('billing_owner', left.billingOwner.id, right.billingOwner.id);
  check('machine', left.machineName, right.machineName);
  check('geo/location', left.geo ?? left.location, right.geo ?? right.location);
  check('created_at', left.createdAt, right.createdAt);
  check('devcontainer_path', left.devcontainerPath, right.devcontainerPath);
  check('git_status.sha', left.gitStatus.sha, right.gitStatus.sha);
  return { ok: mismatches.length === 0, mismatches };
}

/** Enforce identity of a readback resource against the durable record before any further action. */
export function verifyCodespacesIdentity(record: CodespacesWorkspaceMetadata, resource: CodespacesResource): { ok: boolean; reason: CodespacesRecoveryReason; mismatches: string[] } {
  const mismatches: string[] = [];
  if (resource.id !== record.remote.codespaceId) mismatches.push(`codespaceId ${resource.id}`);
  if (resource.name !== record.remote.name) mismatches.push(`name ${resource.name}`);
  if (resource.environmentId !== record.remote.environmentId) mismatches.push(`environmentId ${resource.environmentId}`);
  if (resource.owner.id !== record.remote.ownerId || resource.owner.id !== record.control.actorId) mismatches.push(`creator actor ${resource.owner.id}`);
  if (resource.owner.login !== record.remote.ownerLogin || resource.owner.login !== record.control.actorLogin) mismatches.push(`creator login ${resource.owner.login}`);
  if (resource.repositoryId !== record.repository.id) mismatches.push(`repositoryId ${resource.repositoryId}`);
  if (resource.repository.owner !== record.repository.owner || resource.repository.name !== record.repository.name) mismatches.push(`repository ${resource.repository.owner}/${resource.repository.name}`);
  if (resource.billingOwner.id !== record.remote.billableOwnerId) mismatches.push(`billable owner ${resource.billingOwner.id}`);
  if (resource.machineName !== record.remote.machine) mismatches.push(`machine ${resource.machineName}`);
  if ((resource.geo ?? resource.location) !== record.remote.geo) mismatches.push(`geo/location ${resource.geo ?? resource.location}`);
  if (resource.createdAt !== record.remote.createdAt) mismatches.push(`createdAt ${resource.createdAt}`);
  if (resource.devcontainerPath !== record.source.devcontainerPath) mismatches.push(`devcontainerPath ${resource.devcontainerPath}`);
  if (resource.gitStatus.sha !== record.source.expectedOid) return { ok: false, reason: 'revision-mismatch', mismatches: [`HEAD ${resource.gitStatus.sha}`, ...mismatches] };
  if (resource.gitStatus.ref && resource.gitStatus.ref !== requestedBranchShort(record.source.requestedRef) && resource.gitStatus.ref !== record.source.requestedRef) mismatches.push(`effective ref ${resource.gitStatus.ref}`);
  return { ok: mismatches.length === 0, reason: 'identity-mismatch', mismatches };
}

function requestedBranchShort(ref: string): string {
  const match = /^refs\/heads\/(.+)$/.exec(ref);
  return match?.[1] ?? ref;
}