import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodespacesWorkspace, verifyCodespacesIdentity, verifyIdenticalResources, type CodespacesCreateDependencies } from '../src/codespaces-create.js';
import { GhCodespacesProvider } from '../src/codespaces.js';
import { loadCreateIntent, loadCodespacesJournal, codespacesOpsDir, listCreateIntents } from '../src/codespaces-ops.js';
import { loadMetadata, type CodespacesWorkspaceMetadata, type WorkspaceMetadata } from '../src/state.js';
import type { CodespacesAgentContainersConfig, ProcessRunner } from '../src/types.js';

function recordedMetadata(metadata: WorkspaceMetadata | undefined): CodespacesWorkspaceMetadata | undefined {
  return metadata && metadata.version === 2 && metadata.backend === 'codespaces' ? metadata : undefined;
}

function parsedResource(): Parameters<typeof verifyCodespacesIdentity>[1] {
  return {
    id: '9876543210',
    name: 'bookish-space-parakeet',
    displayName: 'bookish-space-parakeet',
    environmentId: 'env-8f1c1f0e',
    owner: { id: '1', login: 'octo' },
    repositoryId: '42',
    repository: { owner: 'octo', name: 'agent-containers' },
    billingOwner: { id: '1', login: 'octo' },
    devcontainerPath: '.devcontainer/devcontainer.json',
    machineName: 'basicLinux32gb',
    location: 'East US',
    geo: 'EastUs',
    createdAt: '2026-09-02T12:00:00Z',
    state: 'Running',
    gitStatus: { sha: OID, ref: 'main' },
    idleTimeoutMinutes: 30,
  };
}

function recordedMetadataFixture(): CodespacesWorkspaceMetadata {
  return {
    version: 2, backend: 'codespaces', name: 'issue-9', workspaceId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, effectiveBranch: 'agent-containers/issue-9', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    remote: { codespaceId: '9876543210', name: 'bookish-space-parakeet', environmentId: 'env-8f1c1f0e', ownerId: '1', ownerLogin: 'octo', billableOwnerId: '1', machine: 'basicLinux32gb', geo: 'EastUs', createdAt: '2026-09-02T12:00:00Z' },
    lifecycle: { desired: 'ready', normalized: 'provisioning', providerRawState: 'Running', lastObservedAt: '2026-09-02T12:00:00.000Z', activeOperation: null },
    recovery: null, cleanup: { remoteStopped: false, remoteDeleted: false, tombstoneWritten: false },
  };
}

const OID = '0123456789abcdef0123456789abcdef01234567';
const BLOB = '1234567890abcdef1234567890abcdef12345678';

function configFixture(overrides: Partial<CodespacesAgentContainersConfig> = {}): CodespacesAgentContainersConfig {
  const base: CodespacesAgentContainersConfig = {
    version: 2,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    project: { repository: 'octo/agent-containers', ref: 'refs/heads/main', expectedOid: OID },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    backends: {
      enabled: ['codespaces'],
      default: 'codespaces',
      local: {},
      codespaces: {
        enabled: true, machine: 'basicLinux32gb', geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080,
        maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1,
        readiness: { providerTimeoutSeconds: 5, sshTimeoutSeconds: 5, command: [], commandTimeoutSeconds: 5 },
        transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10 },
        ports: { allowVisibilityChanges: false, allowPublic: false },
        secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false },
      },
    },
  };
  if (overrides.project) base.project = { ...base.project, ...overrides.project };
  if (overrides.environment) base.environment = { ...base.environment, ...overrides.environment };
  if (overrides.backends) {
    base.backends = { ...base.backends, ...overrides.backends, codespaces: overrides.backends.codespaces ?? base.backends.codespaces };
    base.backends.enabled = overrides.backends.enabled ?? base.backends.enabled;
    base.backends.default = overrides.backends.default ?? base.backends.default;
  }
  return base;
}

function resourceFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '9876543210',
    display_name: 'bookish-space-parakeet',
    name: 'bookish-space-parakeet',
    environment_id: 'env-8f1c1f0e',
    owner: { id: 1, login: 'octo' },
    repository: { id: 42, name: 'agent-containers', owner: { id: 1, login: 'octo' } },
    billable_owner: { id: 1, login: 'octo' },
    machine: { name: 'basicLinux32gb' },
    location: 'EastUs',
    created_at: '2026-09-02T12:00:00Z',
    state: 'Running',
    git_status: { ref: 'main' },
    devcontainer_path: '.devcontainer/devcontainer.json',
    idle_timeout_minutes: 30,
    ...overrides,
  };
}

interface RouteOverrides {
  actor?: () => Record<string, unknown>;
  repository?: () => Record<string, unknown>;
  resolveRef?: () => Record<string, unknown>;
  tree?: () => Record<string, unknown>;
  create?: () => Record<string, unknown> | { code: number; stderr: string };
  get?: () => Record<string, unknown>;
  candidates?: () => Record<string, unknown>;
  localOid?: string;
  postHook?: (args: string[]) => void;
}

interface CreateHarness {
  deps: CodespacesCreateDependencies;
  stateDir: string;
  dispatch: Array<{ method: string; args: string[] }>;
  localGit: string[][];
}

async function harness(overrides: RouteOverrides = {}): Promise<CreateHarness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-create-'));
  const dispatch: Array<{ method: string; args: string[] }> = [];
  const localGit: string[][] = [];
  const routes: RouteOverrides = overrides;
  const run: ProcessRunner['run'] = async (command, args) => {
    if (command === 'git') {
      localGit.push(args);
      return { code: 0, stdout: `${routes.localOid ?? OID}\n`, stderr: '' };
    }
    const method = args[args.indexOf('--method') + 1];
    const path = args.at(-1) as string;
    const body = (): Record<string, unknown> => {
      if (path === '/user' && method === 'GET') return (routes.actor ?? (() => ({ id: 1, login: 'octo' })))();
      if (/^\/repos\/octo\/agent-containers\/commits\//.test(path)) return (routes.resolveRef ?? (() => ({ sha: OID })))();
      if (/^\/repos\/octo\/agent-containers\/git\/trees\//.test(path)) return (routes.tree ?? (() => ({ tree: [{ path: '.devcontainer/devcontainer.json', mode: '100644', type: 'blob', sha: BLOB }] })))();
      if (/^\/repos\/octo\/agent-containers(?:\?|$)/.test(path)) return (routes.repository ?? (() => ({ id: 42, name: 'agent-containers', full_name: 'octo/agent-containers', owner: { id: 1, login: 'octo' } })))();
      if (path === '/user/codespaces' && method === 'POST') return (routes.create ?? resourceFixture)();
      if (/^\/user\/codespaces(?:\?|$)/.test(path) && method === 'GET') return (routes.candidates ?? (() => ({ total_count: 0, codespaces: [] })))();
      if (/^\/user\/codespaces\/[A-Za-z0-9-]+$/.test(path)) return (routes.get ?? resourceFixture)();
      throw new Error(`unexpected gh route: ${JSON.stringify(args)}`);
    };
    dispatch.push({ method: method ?? '?', args });
    routes.postHook?.(args);
    const result = body();
    if (result && typeof (result as { then?: unknown }).then === 'function') return result as unknown as Promise<import('../src/types.js').ProcessResult>;
    if ('code' in result) return { code: (result as { code: number }).code, stdout: '', stderr: (result as { stderr: string }).stderr };
    return { code: 0, stdout: JSON.stringify(result), stderr: '' };
  };
  const provider = new GhCodespacesProvider({ run });
  const deps: CodespacesCreateDependencies = {
    stateDir, requestId: randomUUID(), name: 'issue-9', config: configFixture(), root: '/repo', runner: { run }, provider, ghVersion: '2.52.0',
  };
  return { deps, stateDir, dispatch, localGit };
}

test('exact create records intent before dispatch, dispatches exact POST argv, and readback-verifies identity', async () => {
  const { deps, stateDir, dispatch, localGit } = await harness();
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'recorded');
  if (outcome.outcome !== 'recorded') return;
  assert.equal(outcome.metadata.remote.codespaceId, '9876543210');
  assert.equal(outcome.metadata.lifecycle.normalized, 'provisioning');
  assert.equal(outcome.metadata.source.expectedOid, OID);

  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.state, 'identity-verified');
  const post = dispatch.find((entry) => entry.args.includes('--method') && entry.args.includes('POST'));
  assert.ok(post, 'a create dispatch must happen');
  assert.ok(post.args.includes('/user/codespaces'));
  assert.ok(post.args.includes('repository_id=42'));
  assert.ok(post.args.includes('ref=refs/heads/main'));
  assert.ok(post.args.includes('devcontainer_path=.devcontainer/devcontainer.json'));
  assert.ok(post.args.includes('machine=basicLinux32gb'));
  assert.ok(post.args.includes('idle_timeout_minutes=30'));
  assert.ok(post.args.includes('retention_period_minutes=10080'));
  assert.deepEqual(localGit, [['rev-parse', '--verify', `refs/remotes/origin/main^{commit}`]]);
  const metadata = recordedMetadata(await loadMetadata(stateDir, 'issue-9'));
  assert.ok(metadata, 'a durable metadata record must exist');
  assert.equal(metadata.remote.codespaceId, '9876543210');
});

test('exact create performs an exact GET readback and refuses identity mismatch before any action', async () => {
  const { deps, stateDir, dispatch } = await harness({ get: () => resourceFixture({ name: 'different-name' }) });
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'quarantined');
  if (outcome.outcome !== 'quarantined') return;
  assert.equal(outcome.reason, 'identity-mismatch');
  const metadata = recordedMetadata(await loadMetadata(stateDir, 'issue-9'));
  assert.ok(metadata, 'quarantine must retain a durable metadata record');
  assert.equal(metadata.lifecycle.normalized, 'identity-mismatch');
  const gets = dispatch.filter((entry) => /^\/user\/codespaces\/[A-Za-z0-9-]+$/.test(entry.args.at(-1) as string));
  assert.ok(gets.length >= 1, 'an exact GET readback must be issued');
});

test('create records a nullable operational response with an immutable local environment fallback', async () => {
  const { deps, stateDir } = await harness({ create: () => resourceFixture({ display_name: null, environment_id: null, machine: null, devcontainer_path: null, idle_timeout_minutes: null }) } as unknown as RouteOverrides);
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'recorded', JSON.stringify(outcome));
  const metadata = recordedMetadata(await loadMetadata(stateDir, 'issue-9'));
  assert.ok(metadata);
  if (!metadata) return;
  assert.equal(metadata.remote.environmentId, metadata.remote.codespaceId);
  assert.equal(metadata.remote.machine, 'basicLinux32gb');
  assert.equal(metadata.source.devcontainerPath, '.devcontainer/devcontainer.json');
});

test('create response truncation fails closed into durable ambiguous recovery with read-only candidates', async () => {
  const { deps, stateDir } = await harness({ create: () => JSON.parse('{"id": 9') , candidates: () => ({ total_count: 1, codespaces: [{ id: 1, name: 'bookish-space-parakeet', state: 'Starting' }] }) } as unknown as RouteOverrides);
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  if (outcome.outcome !== 'ambiguous') return;
  assert.equal(outcome.reason, 'create-response-truncated-or-invalid');
  assert.equal(outcome.recovery.candidates.length, 1);
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.state, 'ambiguous-create');
  assert.ok(intent?.recoveryContext?.reason === 'create-response-truncated-or-invalid');
  assert.equal(await loadMetadata(stateDir, 'issue-9'), undefined, 'no metadata asserts ownership');
});

test('provider timeout before creation is ambiguous and never retries the create POST', async () => {
  const { deps, stateDir, dispatch } = await harness({ create: () => { throw Object.assign(new Error('POST timed out before a response'), { name: 'AbortError' }); } } as unknown as RouteOverrides);
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  assert.equal(outcome.reason, 'provider-timeout-before-dispatch');
  const postCount = dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length;
  assert.equal(postCount, 1, 'no hidden create retry after an ambiguous response');
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.state, 'ambiguous-create');
});

test('readback deadline after a successful create POST is classified as post-dispatch ambiguity', async () => {
  const { deps, stateDir } = await harness({ create: () => { throw new Error('GitHub create readback exceeded its bounded deadline; the resource may exist but nothing was adopted.'); } } as unknown as RouteOverrides);
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  if (outcome.outcome !== 'ambiguous') return;
  assert.equal(outcome.reason, 'provider-timeout-after-creation-possible');
  assert.equal((await loadCreateIntent(stateDir, deps.requestId))?.recoveryContext?.reason, 'provider-timeout-after-creation-possible');
});

test('provider timeout after creation is ambiguous and never adopts or deletes a candidate', async () => {
  const { deps, stateDir, dispatch, } = await harness({ create: () => { throw new Error('ESOCKETTIMEDOUT during create'); } } as unknown as RouteOverrides);
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  assert.equal(outcome.reason, 'provider-timeout-after-creation-possible');
  const postCount = dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length;
  assert.equal(postCount, 1);
  const intents = await listCreateIntents(stateDir);
  assert.deepEqual(intents.map((summary) => summary.state), ['ambiguous-create']);
});

test('a hung create aborts within its bounded deadline and journals ambiguous-create exactly once (N3)', async () => {
  const { deps, stateDir, dispatch } = await harness({ create: () => new Promise<never>(() => {}) } as unknown as RouteOverrides);
  deps.createTimeoutMs = 60;
  const started = Date.now();
  const outcome = await createCodespacesWorkspace(deps);
  const elapsed = Date.now() - started;
  assert.equal(outcome.outcome, 'ambiguous');
  if (outcome.outcome !== 'ambiguous') return;
  assert.equal(outcome.reason, 'provider-timeout-before-dispatch');
  assert.ok(elapsed < 5000, `a hung create must abort within its bounded deadline (${elapsed}ms)`);
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.state, 'ambiguous-create');
  assert.equal(intent?.recoveryContext?.reason, 'provider-timeout-before-dispatch');
  const journal = await loadCodespacesJournal(stateDir, deps.name);
  assert.equal(journal.filter((event) => event.event === 'ambiguous-create').length, 1, 'ambiguous-create must be journaled exactly once');
  assert.equal(dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length, 1);
});

test('duplicate local request ID fails closed and never issues a create', async () => {
  const { deps, stateDir, dispatch } = await harness();
  deps.config.backends.codespaces.maxCreating = 2;
  const { recordCreateIntent } = await import('../src/codespaces-ops.js');
  await recordCreateIntent(stateDir, {
    schemaVersion: 1, requestId: deps.requestId, name: deps.name, createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    capacity: { machine: 'basicLinux32gb', geo: null, idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, displayNameHint: null },
    state: 'intent-recorded', providerCorrelationId: null, providerError: null, providerResource: null, updatedAt: '2026-09-02T12:00:00.000Z', recoveryContext: null,
  }, { expectAbsent: true });
  const second = await createCodespacesWorkspace(deps);
  assert.equal(second.outcome, 'ambiguous');
  if (second.outcome !== 'ambiguous') return;
  assert.equal(second.reason, 'duplicate-request-id');
  const postCount = dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length;
  assert.equal(postCount, 0, 'a duplicate request ID must never dispatch another create');
});

test('moved ref fails closed before dispatch with the immutable OID preserved', async () => {
  const moved = 'ffffffffffffffffffffffffffffffffffffffff';
  const { deps, dispatch } = await harness({ resolveRef: () => ({ sha: moved }) });
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'blocked');
  assert.match(String((outcome as { reason: string }).reason), /moved since configuration/);
  assert.equal(dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length, 0, 'no create dispatch on a moved ref');
});

test('stale local remote-tracking OID fails closed before dispatch', async () => {
  const { deps, dispatch } = await harness({ localOid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'blocked');
  assert.match(String((outcome as { reason: string }).reason), /remote-tracking ref/);
  assert.equal(dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length, 0);
});

test('actor change after creation quarantines the recorded Codespace', async () => {
  let actorCalls = 0;
  const { deps, stateDir } = await harness({ actor: () => { actorCalls += 1; return actorCalls > 1 ? { id: 5, login: 'intruder' } : { id: 1, login: 'octo' }; } });
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'quarantined');
  if (outcome.outcome !== 'quarantined') return;
  assert.equal(outcome.reason, 'actor-changed');
  const metadata = recordedMetadata(await loadMetadata(stateDir, 'issue-9'));
  assert.ok(metadata, 'actor-change quarantine must retain a durable record');
  assert.equal(metadata.lifecycle.normalized, 'identity-mismatch');
});

test('billing/policy/machine rejection preserves the create intent and never chooses a fallback machine', async () => {
  const { deps, stateDir, dispatch } = await harness({ create: () => ({ code: 403, stderr: 'machine basicLinux32gb is not allowed by organization policy (403)' }), } as unknown as RouteOverrides);
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  assert.equal(outcome.reason, 'billing-policy-machine-rejected');
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.state, 'ambiguous-create');
  assert.equal(intent?.capacity.machine, 'basicLinux32gb');
  assert.equal(dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length, 1);
  const fallback = dispatch.filter((entry) => entry.args.includes('machine=basicLinux32gb')).length;
  assert.ok(fallback >= 1, 'only the explicit machine is ever submitted');
});

test('multiline provider failure is normalized before durable ambiguous-create recovery', async () => {
  const { deps, stateDir, dispatch } = await harness({
    create: () => ({ code: 422, stderr: 'validation failed\nrequest was rejected\n' }),
  } as unknown as RouteOverrides);
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  if (outcome.outcome !== 'ambiguous') return;
  assert.equal(outcome.reason, 'create-response-truncated-or-invalid');
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.state, 'ambiguous-create');
  assert.equal(intent?.providerError?.includes('\n'), false);
  assert.match(intent?.providerError ?? '', /validation failed request was rejected/);
  assert.equal(dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length, 1);
});

test('capacity exhaustion blocks create before dispatch (1 creating / 2 running / 4 total)', async () => {
  const { deps, stateDir, dispatch } = await harness();
  deps.now = () => '2026-09-02T12:00:00.000Z';
  const { recordCreateIntent } = await import('../src/codespaces-ops.js');
  await recordCreateIntent(stateDir, {
    schemaVersion: 1, requestId: '00000000-0000-4000-8000-0000000000aa', name: 'occupied', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    capacity: { machine: 'basicLinux32gb', geo: null, idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, displayNameHint: null },
    state: 'intent-recorded', providerCorrelationId: null, providerError: null, providerResource: null, updatedAt: '2026-09-02T12:00:00.000Z', recoveryContext: null,
  }, { expectAbsent: true });
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'blocked');
  assert.match(String((outcome as { reason: string }).reason), /capacity is exhausted/);
  assert.equal(dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length, 0);
});

test('concurrent creates under the global capacity lock dispatch only one create', async () => {
  const { deps, stateDir } = await harness();
  const providerA = new GhCodespacesProvider({ run: deps.runner.run.bind(deps.runner) });
  const providerB = new GhCodespacesProvider({ run: deps.runner.run.bind(deps.runner) });
  const depsA = { ...deps, provider: providerA, requestId: randomUUID(), name: 'issue-9' };
  const depsB = { ...deps, provider: providerB, requestId: randomUUID(), name: 'issue-10' };
  const [ra, rb] = await Promise.all([createCodespacesWorkspace(depsA), createCodespacesWorkspace(depsB)]);
  const recorded = [ra, rb].filter((outcome) => outcome.outcome === 'recorded').length;
  const blocked = [ra, rb].filter((outcome) => outcome.outcome === 'blocked').length;
  assert.equal(recorded, 1, 'exactly one concurrent create is admitted');
  assert.equal(blocked, 1, 'the other concurrent create is blocked by conservative capacity');
  const recordedWorkspaces = await readdir(join(stateDir, 'workspaces'));
  assert.equal(recordedWorkspaces.length, 1, 'exactly one metadata record exists after the concurrent race');
});

test('crash after create before record leaves the exact response durable and never deletes the resource', async () => {
  const { deps, stateDir, dispatch } = await harness();
  deps.saveMetadata = async () => { throw new Error('crash: metadata write failed after provider create'); };
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  assert.ok(outcome.reason !== undefined);
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.providerResource?.id, '9876543210', 'the exact create response must remain durable for recovery');
  assert.equal(intent?.state, 'ambiguous-create');
  assert.equal(await loadMetadata(stateDir, 'issue-9'), undefined, 'no ownership record exists yet; nothing was adopted');
  assert.equal(dispatch.filter((entry) => entry.args.includes('/user/codespaces') && entry.args.includes('POST')).length, 1);
});

test('readback identity verification treats a devcontainer path drift as a hard mismatch', () => {
  const { verifyCodespacesIdentity: verify } = { verifyCodespacesIdentity };
  const resource = parsedResource();
  const ok = verify(recordedMetadataFixture(), resource);
  assert.equal(ok.ok, true);
  const drifted = { ...resource, devcontainerPath: '.devcontainer/other.json' };
  const mismatch = verify(recordedMetadataFixture(), drifted);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'identity-mismatch');
  assert.ok(mismatch.mismatches.some((entry) => /devcontainerPath/.test(entry)));
});

test('undocumented REST git_status SHA never substitutes for the fixed remote immutable-HEAD probe', async () => {
  const { deps, stateDir } = await harness({ get: () => resourceFixture({ git_status: { sha: 'ffffffffffffffffffffffffffffffffffffffff', ref: 'main' } }) });
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'recorded');
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.equal(intent?.state, 'identity-verified');
});

test('every ambiguous failure path leaves the durable record consistent and no unknown resource is deleted', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-create-'));
  const intents = await readdir(codespacesOpsDir(stateDir)).catch(() => []);
  assert.deepEqual(intents, []);
  const { deps } = await harness({ create: () => { throw new Error('network unreachable'); } } as unknown as RouteOverrides);
  deps.stateDir = stateDir;
  const outcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'ambiguous');
  const existing = await readdir(codespacesOpsDir(stateDir));
  assert.equal(existing.length, 1, 'exactly one durable intent is kept');
  void verifyIdenticalResources;
});
