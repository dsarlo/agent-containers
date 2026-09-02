import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodespacesExecutionBackend } from '../src/backend.js';
import { createCodespacesWorkspace } from '../src/codespaces-create.js';
import { runReadinessProbes, type CodespacesReadinessDependencies } from '../src/codespaces-readiness.js';
import { doctor } from '../src/setup.js';
import { GhCodespacesProvider } from '../src/codespaces.js';
import { loadCreateIntent, recordCreateIntent } from '../src/codespaces-ops.js';
import { loadMetadata, saveMetadata, type CodespacesWorkspaceMetadata } from '../src/state.js';
import { runCli } from '../src/cli.js';
import { nodeProcessRunner } from '../src/workspaces.js';
import type { CodespacesAgentContainersConfig, ProcessRunner } from '../src/types.js';

const OID = '0123456789abcdef0123456789abcdef01234567';
const BLOB = '1234567890abcdef1234567890abcdef12345678';
const TOKEN_FIXTURE = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz123456';

function configFixture(): CodespacesAgentContainersConfig {
  return {
    version: 2,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    project: { repository: 'octo/agent-containers', ref: 'refs/heads/main', expectedOid: OID },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    backends: {
      enabled: ['codespaces'], default: 'codespaces', local: {},
      codespaces: {
        enabled: true, machine: 'basicLinux32gb', geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080,
        maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1,
        readiness: { providerTimeoutSeconds: 5, sshTimeoutSeconds: 5, command: [], commandTimeoutSeconds: 5 },
        transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 1, remoteLogRetentionHours: 1 },
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

function readinessRunner(): ProcessRunner {
  return {
    async run(command, args) {
      const key = ['gh', ...args].join(' ');
      const path = args.at(-1) as string;
      const method = args[args.indexOf('--method') + 1];
      if (command === 'git') return { code: 0, stdout: `${OID}\n`, stderr: '' };
      if (command === 'gh' && path === '/user' && method === 'GET') return { code: 0, stdout: JSON.stringify({ id: 1, login: 'octo' }), stderr: '' };
      if (command === 'gh' && /^\/repos\/octo\/agent-containers\/commits\//.test(path)) return { code: 0, stdout: JSON.stringify({ sha: OID }), stderr: '' };
      if (command === 'gh' && /^\/repos\/octo\/agent-containers\/git\/trees\//.test(path)) return { code: 0, stdout: JSON.stringify({ tree: [{ path: '.devcontainer/devcontainer.json', mode: '100644', type: 'blob', sha: BLOB }] }), stderr: '' };
      if (command === 'gh' && /^\/repos\/octo\/agent-containers(?:\?|$)/.test(path)) return { code: 0, stdout: JSON.stringify({ id: 42, name: 'agent-containers', full_name: 'octo/agent-containers', owner: { id: 1, login: 'octo' } }), stderr: '' };
      if (command === 'gh' && path === '/user/codespaces' && method === 'POST') return { code: 0, stdout: JSON.stringify(resourceFixture()), stderr: '' };
      if (command === 'gh' && /^\/user\/codespaces(?:\?|$)/.test(path) && method === 'GET') return { code: 0, stdout: JSON.stringify({ total_count: 0, codespaces: [] }), stderr: '' };
      if (command === 'gh' && /^\/user\/codespaces\/[A-Za-z0-9-]+$/.test(path)) return { code: 0, stdout: JSON.stringify(resourceFixture()), stderr: '' };
      if (command === 'gh' && args[0] === 'codespace' && args[1] === 'logs') return { code: 0, stdout: `build line token ${TOKEN_FIXTURE}\n`, stderr: '' };
      if (command === 'gh' && args[0] === 'codespace' && args[1] === 'ssh') {
        if (key.includes('rev-parse --show-toplevel')) return { code: 0, stdout: '/workspaces/agent-containers\n', stderr: '' };
        if (key.includes('rev-parse HEAD')) return { code: 0, stdout: `${OID}\n`, stderr: '' };
        if (key.includes('remote get-url origin')) return { code: 0, stdout: 'git@github.com:octo/agent-containers.git\n', stderr: '' };
        if (key.includes('printf')) return { code: 0, stdout: 'agent-containers-readiness-probe\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected dispatch: ${JSON.stringify(args)}`);
    },
  };
}

function recordedWorkspace(): CodespacesWorkspaceMetadata {
  return {
    version: 2, backend: 'codespaces', name: 'issue-9', workspaceId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, effectiveBranch: 'agent-containers/issue-9', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    remote: { codespaceId: '9876543210', name: 'bookish-space-parakeet', environmentId: 'env-8f1c1f0e', ownerId: '1', ownerLogin: 'octo', billableOwnerId: '1', machine: 'basicLinux32gb', geo: 'EastUs', createdAt: '2026-09-02T12:00:00Z' },
    lifecycle: { desired: 'ready', normalized: 'provisioning', providerRawState: 'Running', lastObservedAt: '2026-09-02T12:00:00.000Z', activeOperation: { id: '00000000-0000-4000-8000-0000000000bb', kind: 'create', startedAt: '2026-09-02T12:00:00.000Z', checkpoint: 'identity-verified' } },
    recovery: null, cleanup: { remoteStopped: false, remoteDeleted: false, tombstoneWritten: false },
  };
}

async function recordIssue9Intent(stateDir: string, requestId = '00000000-0000-4000-8000-0000000000cc'): Promise<void> {
  await recordCreateIntent(stateDir, {
    schemaVersion: 1, requestId, name: 'issue-9', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    capacity: { machine: 'basicLinux32gb', geo: null, idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, displayNameHint: null },
    state: 'identity-verified', providerCorrelationId: null, providerError: null, providerResource: null, updatedAt: '2026-09-02T12:00:00.000Z', recoveryContext: null,
  }, { expectAbsent: true });
}

test('Codespaces execution backend stays phase-gated without the experimental environment flag', async () => {
  const previous = process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  try {
    const backend = createCodespacesExecutionBackend({ stateDir: '/tmp/st', config: configFixture(), runner: readinessRunner(), root: '/repo' });
    await assert.rejects(() => backend.create({ name: 'issue-9', backend: 'codespaces' }), /phase-gated/);
    await assert.rejects(() => backend.observe({ kind: 'codespaces', id: 'x', name: 'y', environmentId: 'z' }), /phase-gated/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
    else process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = previous;
  }
});

test('doctor runs the same bounded provisioned-runtime probes only for exactly recorded workspaces', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-backend-')), 'state');
  await saveMetadata(stateDir, recordedWorkspace(), { expectedGeneration: null });
  await recordIssue9Intent(stateDir);
  const report = await doctor(configFixture(), 'codespaces', readinessRunner(), '/repo', { stateDir, workspaceName: 'issue-9' });
  const ids = report.checks.filter((check) => check.id.startsWith('codespaces.runtime.')).map((check) => check.id);
  assert.deepEqual(ids, [
    'codespaces.runtime.provider',
    'codespaces.runtime.readback',
    'codespaces.runtime.repository',
    'codespaces.runtime.creation-logs',
    'codespaces.runtime.ssh',
    'codespaces.runtime.readiness-command',
  ]);
  const provisioned = report.checks.filter((check) => check.id === 'codespaces.workspace.metadata' || check.id.startsWith('codespaces.runtime.'));
  assert.ok(provisioned.every((check) => check.phase === 'provisioned-runtime' && ['ready', 'action-required', 'unsupported'].includes(check.state)));
  const gateway = report.checks.find((check) => check.id === 'codespaces.workspace.metadata');
  assert.equal(gateway?.state, 'ready');
});

test('doctor never treats a stopped recorded Codespace as reachable and never starts it', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-backend-')), 'state');
  const stopped = recordedWorkspace();
  stopped.lifecycle = { ...stopped.lifecycle, normalized: 'stopped', providerRawState: 'Stopped' };
  await saveMetadata(stateDir, stopped, { expectedGeneration: null });
  const runtimeProbes = new Set<string>();
  const runner: ProcessRunner = { async run(_command, args) {
    const argsText = args.join(' ');
    if (/codespace (ssh|logs)|user\/codespaces\//.test(argsText)) runtimeProbes.add(argsText.slice(0, 60));
    return { code: 0, stdout: '{}', stderr: '' };
  } };
  const report = await doctor(configFixture(), 'codespaces', runner, '/repo', { stateDir, workspaceName: 'issue-9' });
  const runtime = report.checks.find((check) => check.id === 'codespaces.workspace.runtime');
  assert.equal(runtime?.state, 'action-required');
  assert.match(runtime?.summary ?? '', /stopped/);
  assert.equal(runtimeProbes.size, 0, 'doctor must never run provisioned-runtime probes or start a stopped Codespace');
});

test('CLI create for the Codespaces backend requires the experimental gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-create-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: root });
  const messages: string[] = [];
  const previous = process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  try {
    const code = await runCli(['create', 'issue-9', '--backend', 'codespaces', '--yes-cost'], root, (message) => messages.push(message));
    assert.equal(code, 1);
    assert.match(messages.at(-1) ?? '', /AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
    else process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = previous;
  }
});

test('CLI wait reports each independent readiness gate and ready-without-setup-proof', async () => {
  const xdg = await mkdtemp(join(tmpdir(), 'agent-containers-cli-wait-xdg-'));
  const stateDir = join(xdg, 'agent-containers');
  await saveMetadata(stateDir, recordedWorkspace(), { expectedGeneration: null });
  await recordIssue9Intent(stateDir);
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-root-'));
  await writeFile(join(root, '.agent-containers.yml'), `${JSON.stringify(configFixture(), null, 2)}\n`);
  const original = nodeProcessRunner.run;
  nodeProcessRunner.run = async (command, args, options) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: `${root}\n`, stderr: '' };
    return readinessRunner().run(command, args, options);
  };
  const previous = process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  const previousState = process.env.XDG_STATE_HOME;
  const messages: string[] = [];
  try {
    process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = '1';
    process.env.XDG_STATE_HOME = xdg;
    const code = await runCli(['wait', 'issue-9', '--for', 'ready'], root, (message) => messages.push(message));
    assert.equal(code, 0);
    assert.ok(messages.some((message) => /repository-identity: passed/.test(message)), 'each gate is reported independently');
    assert.ok(messages.some((message) => /ssh-ready: passed/.test(message)));
    assert.match(messages.at(-1) ?? '', /ready-without-setup-proof/);
  } finally {
    nodeProcessRunner.run = original;
    if (previous === undefined) delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
    else process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = previous;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
  }
});

test('creating A then settling readiness admits B without occupying the creating slot (B1)', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-backend-')), 'state');
  const runner = readinessRunner();
  const a = await createCodespacesWorkspace({ stateDir, requestId: '00000000-0000-4000-8000-0000000000aa', name: 'issue-9', config: configFixture(), root: '/repo', runner, provider: new GhCodespacesProvider(runner), ghVersion: '2.52.0' });
  assert.equal(a.outcome, 'recorded');
  if (a.outcome !== 'recorded') return;
  assert.equal(a.metadata.lifecycle.normalized, 'provisioning');
  const readiness = await runReadinessProbes({ stateDir, name: 'issue-9', provider: new GhCodespacesProvider(runner), config: configFixture() });
  assert.equal(readiness.terminal, 'ready-without-setup-proof');
  const settled = await loadMetadata(stateDir, 'issue-9');
  assert.ok(settled && settled.version === 2 && settled.backend === 'codespaces');
  assert.equal(settled.lifecycle.normalized, 'ready-without-setup-proof', 'readiness must durably settle the creating workspace');
  const b = await createCodespacesWorkspace({ stateDir, requestId: '00000000-0000-4000-8000-0000000000bb', name: 'issue-10', config: configFixture(), root: '/repo', runner, provider: new GhCodespacesProvider(runner), ghVersion: '2.52.0' });
  assert.equal(b.outcome, 'recorded', 'the settled workspace must not hold the single creating slot');
});

test('CLI wait honors --timeout as an overall deadline and returns the timeout outcome (N1)', async () => {
  const xdg = await mkdtemp(join(tmpdir(), 'agent-containers-cli-wait-timeout-xdg-'));
  const stateDir = join(xdg, 'agent-containers');
  await saveMetadata(stateDir, recordedWorkspace(), { expectedGeneration: null });
  await recordIssue9Intent(stateDir);
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-root-'));
  await writeFile(join(root, '.agent-containers.yml'), `${JSON.stringify(configFixture(), null, 2)}\n`);
  const original = nodeProcessRunner.run;
  nodeProcessRunner.run = async (command, args, options) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: `${root}\n`, stderr: '' };
    if (command === 'gh' && /^\/user\/codespaces\/[A-Za-z0-9-]+$/.test(args.at(-1) ?? '')) return { code: 0, stdout: JSON.stringify(resourceFixture({ state: 'Starting' })), stderr: '' };
    if (command === 'gh' && args[0] === 'codespace' && args[1] === 'ssh') return { code: 0, stdout: '', stderr: '' };
    if (command === 'gh' && args[0] === 'codespace' && args[1] === 'logs') return { code: 0, stdout: 'build line\n', stderr: '' };
    return readinessRunner().run(command, args, options);
  };
  const previous = process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  const previousState = process.env.XDG_STATE_HOME;
  const messages: string[] = [];
  const started = Date.now();
  try {
    process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = '1';
    process.env.XDG_STATE_HOME = xdg;
    const code = await runCli(['wait', 'issue-9', '--for', 'ready', '--timeout', '300ms'], root, (message) => messages.push(message));
    const elapsed = Date.now() - started;
    assert.equal(code, 1, messages.join('\n'));
    assert.match(messages.at(-1) ?? '', /did not become ready \(timeout\)/);
    assert.ok(elapsed < 5000, `wait --timeout must bound the overall wait (${elapsed}ms)`);
  } finally {
    nodeProcessRunner.run = original;
    if (previous === undefined) delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
    else process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = previous;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
  }
});

test('no token-shaped fixture appears in any persisted file or captured readiness output', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-secret-')), 'state');
  const runner = readinessRunner();
  const deps = {
    stateDir, requestId: '00000000-0000-4000-8000-0000000000cc', name: 'issue-9', config: configFixture(), root: '/repo', runner,
    provider: new GhCodespacesProvider(runner), ghVersion: '2.52.0',
  };
  const outcome: import('../src/codespaces-create.js').CodespacesCreateOutcome = await createCodespacesWorkspace(deps);
  assert.equal(outcome.outcome, 'recorded');
  const readinessDeps: CodespacesReadinessDependencies = { stateDir, name: 'issue-9', provider: new GhCodespacesProvider(runner), config: configFixture() };
  const report = await runReadinessProbes(readinessDeps);
  assert.notEqual(report.terminal, 'blocked');
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(TOKEN_FIXTURE), 'readiness report must redact token-shaped values');

  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const source = await readFile(path, 'utf8');
      files.push(source);
    }
  };
  await walk(join(stateDir, 'codespaces', 'ops'));
  await walk(join(stateDir, 'codespaces', 'events'));
  await walk(join(stateDir, 'workspaces'));
  const stateFiles = await readdir(join(stateDir, 'codespaces', 'ops'));
  void stateFiles;
  assert.ok(files.length > 0, 'durable state exists to audit');
  assert.ok(files.every((source) => !source.includes(TOKEN_FIXTURE)), 'no secret-shaped fixture is ever persisted');
  const intent = await loadCreateIntent(stateDir, deps.requestId);
  assert.ok(intent && intent.state === 'identity-verified');
  const metadata = await loadMetadata(stateDir, 'issue-9');
  assert.ok(metadata && metadata.version === 2 && metadata.backend === 'codespaces');
});