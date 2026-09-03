import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { waitCodespacesReady, runReadinessProbes, readinessGateDoctorChecks, type CodespacesReadinessDependencies, type ReadinessReport } from '../src/codespaces-readiness.js';
import { GhCodespacesProvider } from '../src/codespaces.js';
import { recordCreateIntent } from '../src/codespaces-ops.js';
import { loadMetadata, saveMetadata, type CodespacesWorkspaceMetadata } from '../src/state.js';
import type { CodespacesAgentContainersConfig, ProcessRunner } from '../src/types.js';

const OID = '0123456789abcdef0123456789abcdef01234567';
const BLOB = '1234567890abcdef1234567890abcdef12345678';

function codespacesRecord(metadata: Awaited<ReturnType<typeof loadMetadata>>): CodespacesWorkspaceMetadata | undefined {
  return metadata && metadata.version === 2 && metadata.backend === 'codespaces' ? metadata : undefined;
}

function configFixture(): CodespacesAgentContainersConfig {
  return {
    version: 2,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    project: { repository: 'octo/agent-containers', ref: 'refs/heads/main', expectedOid: OID },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: '1234567890abcdef1234567890abcdef12345678' },
    backends: {
      enabled: ['codespaces'], default: 'codespaces', local: {},
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
}

function resourceFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '9876543210', display_name: 'bookish-space-parakeet', name: 'bookish-space-parakeet', environment_id: 'env-8f1c1f0e',
    owner: { id: 1, login: 'octo' }, repository_id: 42,
    repository: { id: 42, name: 'agent-containers', owner: { id: 1, login: 'octo' } },
    billing_owner: { id: 1, login: 'octo' }, machine_name: 'basicLinux32gb', location: 'East US', geo: 'EastUs',
    created_at: '2026-09-02T12:00:00Z', state: 'Running',
    git_status: { sha: OID, ref: 'main' }, devcontainer_path: '.devcontainer/devcontainer.json', idle_timeout_minutes: 30, ...overrides,
  };
}

function recordedWorkspace(): CodespacesWorkspaceMetadata {
  return {
    version: 2, backend: 'codespaces', name: 'issue-9', workspaceId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, effectiveBranch: 'agent-containers/issue-9', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: '1234567890abcdef1234567890abcdef12345678' },
    remote: { codespaceId: '9876543210', name: 'bookish-space-parakeet', environmentId: 'env-8f1c1f0e', ownerId: '1', ownerLogin: 'octo', billableOwnerId: '1', machine: 'basicLinux32gb', geo: 'EastUs', createdAt: '2026-09-02T12:00:00Z' },
    lifecycle: { desired: 'ready', normalized: 'provisioning', providerRawState: 'Starting', lastObservedAt: '2026-09-02T12:00:00.000Z', activeOperation: { id: randomUUID(), kind: 'create', startedAt: '2026-09-02T12:00:00.000Z', checkpoint: 'identity-verified' } },
    recovery: null, cleanup: { remoteStopped: false, remoteDeleted: false, tombstoneWritten: false },
  };
}

interface ProbeOptions {
  get?: () => Record<string, unknown>;
  ssh?: Record<string, string | { code: number; stderr: string }>;
  logs?: string | { code: number; stderr: string };
  ports?: ReadonlyArray<{ port: number; visibility: string }>;
}

async function probeContext(options: ProbeOptions = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ready-'));
  const metadata = recordedWorkspace();
  await saveMetadata(stateDir, metadata, { expectedGeneration: null });
  await recordCreateIntent(stateDir, {
    schemaVersion: 1, requestId: '00000000-0000-4000-8000-0000000000aa', name: 'issue-9', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    capacity: { machine: 'basicLinux32gb', geo: null, idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, displayNameHint: null },
    state: 'identity-verified', providerCorrelationId: null, providerError: null, providerResource: null, updatedAt: '2026-09-02T12:00:00.000Z', recoveryContext: null,
  }, { expectAbsent: true });
  const dispatch: string[][] = [];
  const run: ProcessRunner['run'] = async (command, args) => {
    dispatch.push(args);
    const key = ['gh', ...args].join(' ');
    if (command === 'gh' && /\/ports$/.test(args.at(-1) ?? '')) {
      return { code: 0, stdout: JSON.stringify(options.ports ?? []), stderr: '' };
    }
    if (command === 'gh' && /^\/user\/codespaces\/[A-Za-z0-9-]+$/.test(args.at(-1) ?? '')) {
      return { code: 0, stdout: JSON.stringify(options.get ? options.get() : resourceFixture()), stderr: '' };
    }
    if (command === 'gh' && args[0] === 'codespace' && args[1] === 'logs') {
      const result = options.logs ?? 'build log line\n';
      if (typeof result === 'string') return { code: 0, stdout: result, stderr: '' };
      return { code: result.code, stdout: '', stderr: result.stderr };
    }
    if (command === 'gh' && args[0] === 'codespace' && args[1] === 'ssh') {
      if (options.ssh !== undefined && key in options.ssh) {
        const probe = options.ssh[key];
        if (typeof probe === 'string') return { code: 0, stdout: probe, stderr: '' };
        return { code: probe.code, stdout: '', stderr: probe.stderr };
      }
      if (key.includes('rev-parse --show-toplevel')) return { code: 0, stdout: '/workspaces/agent-containers\n', stderr: '' };
      if (key.includes('rev-parse HEAD')) return { code: 0, stdout: `${OID}\n`, stderr: '' };
      if (key.includes('remote get-url origin')) return { code: 0, stdout: 'git@github.com:octo/agent-containers.git\n', stderr: '' };
      if (key.includes('printf')) return { code: 0, stdout: 'agent-containers-readiness-probe\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unrouted readiness probe: ${JSON.stringify(args)}`);
  };
  const deps: CodespacesReadinessDependencies = { stateDir, name: 'issue-9', provider: new GhCodespacesProvider({ run }), config: configFixture() };
  return { deps, dispatch, metadata };
}

test('readiness passes every gate and reports ready-without-setup-proof when no command is configured', async () => {
  const { deps } = await probeContext();
  const report: ReadinessReport = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'ready-without-setup-proof');
  assert.deepEqual(report.gates.map((gate) => [gate.id, gate.state]), [
    ['create-recorded', 'passed'],
    ['resource-recorded', 'passed'],
    ['provider-available', 'passed'],
    ['readback-facts', 'passed'],
    ['ports-private', 'passed'],
    ['repository-identity', 'passed'],
    ['creation-logs', 'passed'],
    ['ssh-ready', 'passed'],
    ['runtime-ready', 'skipped'],
  ]);
});

test('readiness is not ready until repository identity matches the immutable source', async () => {
  const { deps } = await probeContext({
    ssh: { 'gh codespace ssh -c bookish-space-parakeet -- git -C /workspaces/agent-containers rev-parse HEAD': 'ffffffffffffffffffffffffffffffffffffffff' },
  });
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  const identity = report.gates.find((gate) => gate.id === 'repository-identity');
  assert.ok(identity && identity.state === 'blocked');
  assert.match(identity.detail, /HEAD/);
});

test('SSHD absence blocks ssh-ready as unsupported and causes no repository mutation', async () => {
  const { deps, dispatch } = await probeContext({ ssh: { 'gh codespace ssh -c bookish-space-parakeet -- printf %s agent-containers-readiness-probe': { code: 255, stderr: 'ssh: connect: no route' } } });
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  const ssh = report.gates.find((gate) => gate.id === 'ssh-ready');
  assert.ok(ssh && ssh.state === 'blocked');
  assert.match(ssh.detail, /SSHD/i);
  assert.ok(dispatch.every((args) => !/commit|push|reset|merge|delete|write|config|remote (add|set)/.test(args.join(' '))), 'readiness probes must never mutate the repository');
});

test('readiness with an optional configured argv reports ready only when it succeeds', async () => {
  const { deps } = await probeContext();
  deps.config.backends.codespaces.readiness.command = ['node', '-e', 'process.exit(0)'];
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'ready');
  assert.equal(report.gates.find((gate) => gate.id === 'runtime-ready')?.state, 'passed');
});

test('readiness command failure blocks ready with a bounded diagnostic', async () => {
  const line = 'gh codespace ssh -c bookish-space-parakeet -- false';
  const { deps } = await probeContext({ ssh: { [line]: { code: 1, stderr: 'readiness argv failed' } } });
  deps.config.backends.codespaces.readiness.command = ['false'];
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  const command = report.gates.find((gate) => gate.id === 'runtime-ready');
  assert.ok(command && command.state === 'blocked');
});

test('provider polling has a bounded deadline and reports timeout gate', async () => {
  const { deps } = await probeContext({ get: () => resourceFixture({ state: 'Starting' }) });
  deps.config.backends.codespaces.readiness.providerTimeoutSeconds = 1;
  const started = Date.now();
  const report = await runReadinessProbes({ ...deps, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); } });
  const elapsed = Date.now() - started;
  assert.equal(report.terminal, 'timeout');
  assert.ok(elapsed < 5000, `provider polling must be bounded (${elapsed}ms)`);
  const provider = report.gates.find((gate) => gate.id === 'provider-available');
  assert.equal(provider?.state, 'timeout');
});

test('bounded creation logs never expose more than the configured bound', async () => {
  const { deps } = await probeContext({ logs: 'password=supersecret\n'.repeat(50000) });
  const report = await runReadinessProbes(deps);
  const logs = report.gates.find((gate) => gate.id === 'creation-logs');
  assert.ok(logs && logs.state === 'passed');
  assert.ok(logs.detail.length <= 2048 + 128, 'creation-log diagnostics stay bounded');
});

test('cancellation during polling stops the pipeline with the gates observed so far', async () => {
  const { deps } = await probeContext({ get: () => resourceFixture({ state: 'Starting' }) });
  deps.config.backends.codespaces.readiness.providerTimeoutSeconds = 4;
  const controller = new AbortController();
  const reportPromise = runReadinessProbes({ ...deps, signal: controller.signal, sleep: async () => { controller.abort(); } });
  const report = await reportPromise;
  assert.equal(report.terminal, 'skipped');
  assert.ok(report.gates.some((gate) => gate.state === 'skipped'));
});

test('corrupt metadata fails closed and is never treated as absence', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ready-'));
  await mkdir(join(stateDir, 'workspaces'), { recursive: true });
  await writeFile(join(stateDir, 'workspaces', 'issue-9.json'), '{broken', 'utf8');
  const run: ProcessRunner['run'] = async () => ({ code: 0, stdout: '', stderr: '' });
  const deps: CodespacesReadinessDependencies = { stateDir, name: 'issue-9', provider: new GhCodespacesProvider({ run }), config: configFixture() };
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  assert.ok(report.gates[0]?.id === 'create-recorded');
  assert.match(report.gates[0]?.detail, /corrupt|unreadable|invalid/i);
});

test('readiness requires a recorded workspace and never starts one implicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ready-'));
  let dispatched = 0;
  const deps: CodespacesReadinessDependencies = { stateDir, name: 'missing', provider: new GhCodespacesProvider({ run: async () => { dispatched += 1; return { code: 0, stdout: '', stderr: '' }; } }), config: configFixture() };
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  assert.match(report.gates[0]?.detail, /no recorded Codespaces workspace|never creates/i);
  assert.equal(dispatched, 0, 'readiness must never start or mutate anything for an unrecorded workspace');
});

test('doctor check mapping is stable, deterministic, and agrees between human and JSON surfaces', async () => {
  const { deps } = await probeContext();
  const report = await runReadinessProbes(deps);
  const checks = readinessGateDoctorChecks(recordedWorkspace(), report);
  assert.equal(checks.length, 7);
  assert.deepEqual(checks.map((check) => check.id), [
    'codespaces.runtime.provider',
    'codespaces.runtime.readback',
    'codespaces.runtime.ports',
    'codespaces.runtime.repository',
    'codespaces.runtime.creation-logs',
    'codespaces.runtime.ssh',
    'codespaces.runtime.readiness-command',
  ]);
  assert.ok(checks.every((check) => check.phase === 'provisioned-runtime' && ['ready', 'action-required', 'unsupported'].includes(check.state)));
  for (const check of checks) {
    assert.ok(check.summary.length > 0);
    assert.equal(check.state === 'ready', check.remediation.length === 0);
  }
});

test('readiness never reports ready when the SSHD probe could not be reached even if setup looks complete', async () => {
  const { deps } = await probeContext({ ssh: { 'gh codespace ssh -c bookish-space-parakeet -- printf %s agent-containers-readiness-probe': { code: 255, stderr: 'connection refused' } } });
  deps.config.backends.codespaces.readiness.command = ['true'];
  const report = await runReadinessProbes(deps);
  assert.notEqual(report.terminal, 'ready');
  assert.equal(report.terminal, 'blocked');
  assert.ok(report.gates.some((gate) => gate.id === 'ssh-ready' && gate.state === 'blocked'));
});

test('waitCodespacesReady yields one readable event per gate and the terminal report', async () => {
  const { deps } = await probeContext();
  const events = [];
  for await (const event of waitCodespacesReady(deps)) events.push(event);
  assert.equal(events.length, 10);
  const terminal = events.at(-1);
  assert.equal(terminal?.report.terminal, 'ready-without-setup-proof');
  assert.equal(events.filter((event) => event.type === 'readiness').length, 10);
});

test('readiness durably persists a settled ready-without-setup-proof observation (B1)', async () => {
  const { deps } = await probeContext();
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'ready-without-setup-proof');
  const settled = codespacesRecord(await loadMetadata(deps.stateDir, 'issue-9'));
  assert.ok(settled, 'durable metadata must still exist after readiness settles');
  assert.equal(settled.lifecycle.normalized, 'ready-without-setup-proof');
  assert.equal(settled.lifecycle.providerRawState, 'Running');
  assert.ok(Date.parse(settled.lifecycle.lastObservedAt) >= Date.parse('2026-09-02T12:00:00.000Z'), 'lastObservedAt advances when the terminal is observed');
});

test('terminal provider block persists a conservative stopped observation (B1)', async () => {
  const { deps } = await probeContext({ get: () => resourceFixture({ state: 'Stopped' }) });
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  const settled = codespacesRecord(await loadMetadata(deps.stateDir, 'issue-9'));
  assert.ok(settled, 'durable metadata must still exist after a terminal block');
  assert.equal(settled.lifecycle.normalized, 'stopped');
  assert.equal(settled.lifecycle.providerRawState, 'Stopped');
});

test('repository-identity mismatch redacts credential-bearing remote probe output (N2)', async () => {
  const leaked = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz123456';
  const remoteUrl = `https://x-access-token:${leaked}@github.com/octo/attacker.git`;
  const key = 'gh codespace ssh -c bookish-space-parakeet -- git -C /workspaces/agent-containers remote get-url origin';
  const { deps } = await probeContext({ ssh: { [key]: `${remoteUrl}\n` } });
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  const identity = report.gates.find((gate) => gate.id === 'repository-identity');
  assert.ok(identity && identity.state === 'blocked');
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(leaked), 'the PAT must never appear in the readiness report');
  assert.ok(!serialized.includes('x-access-token'), 'the credential-bearing URL must be redacted from the report');
  const checks = readinessGateDoctorChecks(recordedWorkspace(), report);
  const doctorRendered = JSON.stringify(checks);
  assert.ok(!doctorRendered.includes(leaked), 'the PAT must never appear in doctor output');
  assert.ok(!doctorRendered.includes('x-access-token'), 'the credential-bearing URL must be redacted from doctor output');
});

test('matching-but-corrupt create intent fails closed and blocks readiness (N4)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ready-'));
  await saveMetadata(stateDir, recordedWorkspace(), { expectedGeneration: null });
  await mkdir(join(stateDir, 'codespaces', 'ops'), { recursive: true });
  await writeFile(join(stateDir, 'codespaces', 'ops', '00000000-0000-4000-8000-0000000000dd.json'), '{broken', 'utf8');
  const run: ProcessRunner['run'] = async () => ({ code: 0, stdout: '', stderr: '' });
  const deps: CodespacesReadinessDependencies = { stateDir, name: 'issue-9', provider: new GhCodespacesProvider({ run }), config: configFixture() };
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  assert.equal(report.gates[0]?.id, 'create-recorded');
  assert.match(report.gates[0]?.detail, /corrupt|unreadable|invalid|intent/i);
});

test('blank create intent JSON fails closed and blocks readiness (N4)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ready-'));
  await saveMetadata(stateDir, recordedWorkspace(), { expectedGeneration: null });
  await mkdir(join(stateDir, 'codespaces', 'ops'), { recursive: true });
  await writeFile(join(stateDir, 'codespaces', 'ops', '00000000-0000-4000-8000-0000000000dd.json'), '', 'utf8');
  const run: ProcessRunner['run'] = async () => ({ code: 0, stdout: '', stderr: '' });
  const deps: CodespacesReadinessDependencies = { stateDir, name: 'issue-9', provider: new GhCodespacesProvider({ run }), config: configFixture() };
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'blocked');
  assert.match(report.gates[0]?.detail, /corrupt|unreadable|invalid|intent/i);
});

test('creation-log gate failure is a bounded diagnostic that never blocks ready (N5)', async () => {
  const { deps } = await probeContext({ logs: { code: 1, stderr: 'logs endpoint unavailable' } });
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'ready-without-setup-proof');
  const logs = report.gates.find((gate) => gate.id === 'creation-logs');
  assert.ok(logs);
  assert.equal(logs.state, 'blocked');
  assert.match(logs.detail, /diagnostic only/);
});

test('a skipped runtime-ready gate never claims doctor ready without evidence (N6)', async () => {
  const { deps } = await probeContext();
  const report = await runReadinessProbes(deps);
  assert.equal(report.terminal, 'ready-without-setup-proof');
  const checks = readinessGateDoctorChecks(recordedWorkspace(), report);
  const command = checks.find((check) => check.id === 'codespaces.runtime.readiness-command');
  assert.ok(command, 'the readiness-command doctor check must exist');
  assert.equal(command.state, 'action-required');
  assert.ok((command.remediation ?? []).length > 0, 'remediation must guide the operator to prove post-create readiness');
});
