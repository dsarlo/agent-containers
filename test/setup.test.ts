import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configurationDiff, loadConfig, parseConfig, saveConfigAtomic } from '../src/config.js';
import { doctor } from '../src/setup.js';
import type { CodespacesAgentContainersConfig, ProcessRunner } from '../src/types.js';

const codespaces: CodespacesAgentContainersConfig = { version: 2, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: { repository: 'owner/repo', ref: 'refs/heads/main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, backends: { enabled: ['codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };

test('v2 setup preserves safe no-machine defaults and emits a cost-sensitive diff', () => {
  assert.match(configurationDiff(null, codespaces), /machine: null/);
  assert.match(configurationDiff(null, codespaces), /cost-sensitive/);
});

test('atomic configuration save preserves the prior file on compare-and-swap conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-setup-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, 'version: 1\n');
  await assert.rejects(() => saveConfigAtomic(path, codespaces, 'wrong-hash'), /changed concurrently/);
  assert.equal(await readFile(path, 'utf8'), 'version: 1\n');
});

test('doctor permits only read-only prerequisite commands and reports absent runtime explicitly', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) { calls.push([command, ...args]); return { code: 0, stdout: args.at(-1) === '/user' ? '{"id":1,"login":"octo"}' : args[0] === 'api' ? '{"billable_owner":{"id":"1"}}' : 'git version 2.0', stderr: '' }; } };
  const report = await doctor(codespaces, 'codespaces', runner);
  assert.equal(report.overall, 'action-required');
  assert.ok(report.checks.some((check) => check.id === 'codespaces.runtime.workspace' && check.phase === 'provisioned-runtime'));
  assert.deepEqual(calls, [
    ['gh', '--version'],
    ['gh', 'api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/user'],
    ['gh', 'api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/repos/owner/repo/codespaces/new?ref=refs%2Fheads%2Fmain'],
  ]);
});

test('strict v2 rejects secret-shaped fields and incomplete Codespaces repository selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-v2-'));
  const path = join(directory, 'config.yml');
  await writeFile(path, JSON.stringify({ ...codespaces, project: {}, token: 'not-allowed' }));
  await assert.rejects(() => loadConfig(path), /unknown key token/);
  await writeFile(path, JSON.stringify(codespaces));
  await assert.doesNotReject(() => loadConfig(path));
  assert.throws(() => parseConfig(JSON.stringify({ ...codespaces, project: { repository: 'owner/repo' } })), /project\.ref is required/);
  assert.throws(() => parseConfig(JSON.stringify({ ...codespaces, project: { ref: 'refs/heads/main' } })), /project\.repository is required/);
});

test('concurrent configuration saves serialize their compare-and-swap and only one writer publishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-setup-race-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, JSON.stringify(codespaces));
  const expected = (await import('../src/config.js')).hashConfig(await readFile(path, 'utf8'));
  const alternate = structuredClone(codespaces);
  alternate.backends.codespaces.machine = 'basicLinux32gb';
  const results = await Promise.allSettled([
    saveConfigAtomic(path, codespaces, expected),
    saveConfigAtomic(path, alternate, expected),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('doctor has a stable complete Codespaces inventory and uses only its positive read allowlist', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) {
    calls.push([command, ...args]);
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2', stderr: '' };
    if (args.at(-1) === '/user') return { code: 0, stdout: '{"id":"1","login":"octo"}', stderr: '' };
    return { code: 0, stdout: '{"billable_owner":{"id":"1"}}', stderr: '' };
  } };
  const report = await doctor(codespaces, 'codespaces', runner);
  assert.deepEqual(report.checks.map((check) => check.id), [
    'codespaces.gh', 'codespaces.actor', 'codespaces.repository', 'codespaces.ref',
    'codespaces.devcontainer', 'codespaces.preflight', 'codespaces.machine',
    'codespaces.ssh-key', 'codespaces.runtime.workspace',
  ]);
  assert.ok(calls.every(([, ...args]) => args[0] === '--version' || (args[0] === 'api' && args.includes('GET'))));
  assert.ok(calls.every((call) => !call.join(' ').match(/ auth | token|create|start|stop|delete|ssh|secret|port/i)));
  assert.ok(report.checks.filter((check) => check.state !== 'ready').every((check) => check.remediation.at(-1)?.startsWith('Run ac doctor')));
});

test('doctor never marks configured repository facts ready when provider preflight is malformed', async () => {
  const runner: ProcessRunner = { async run(_command, args) {
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2', stderr: '' };
    if (args.at(-1) === '/user') return { code: 0, stdout: '{"id":"1","login":"octo"}', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  } };
  const report = await doctor(codespaces, 'codespaces', runner);
  for (const id of ['codespaces.repository', 'codespaces.ref', 'codespaces.devcontainer', 'codespaces.preflight']) {
    assert.notEqual(report.checks.find((check) => check.id === id)?.state, 'ready', `${id} requires provider evidence`);
  }
});
