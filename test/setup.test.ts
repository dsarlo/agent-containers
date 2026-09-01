import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configurationDiff, loadConfig, parseConfig, saveConfigAtomic } from '../src/config.js';
import { doctor, validateCodespacesSetup } from '../src/setup.js';
import { parseCodespacesPreflight } from '../src/codespaces.js';
import type { CodespacesAgentContainersConfig, ProcessRunner } from '../src/types.js';
import type { StateDurabilityAdapter } from '../src/durability.js';

const codespaces: CodespacesAgentContainersConfig = { version: 2, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: { repository: 'owner/repo', ref: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, backends: { enabled: ['codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
const durability: StateDurabilityAdapter = { publicationMode: async () => 'strict', assertStateWriteSupport: async () => undefined, syncFile: async () => undefined, syncDirectory: async () => undefined, moveFileWriteThrough: async () => undefined };

test('v2 setup preserves safe no-machine defaults and emits a cost-sensitive diff', () => {
  assert.match(configurationDiff(null, codespaces), /machine: null/);
  assert.match(configurationDiff(null, codespaces), /cost-sensitive/);
});

test('Codespaces setup validation requires remote ref, immutable commit, and a regular committed Dev Container blob', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) {
    calls.push([command, ...args]);
    if (command === 'git') return { code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
    if (args.at(-1) === '/repos/owner/repo/commits/refs%2Fheads%2Fmain') return { code: 0, stdout: '{"sha":"0123456789012345678901234567890123456789"}', stderr: '' };
    return { code: 0, stdout: '{"type":"file","sha":"abcdefabcdefabcdefabcdefabcdefabcdefabcd"}', stderr: '' };
  } };
  const evidence = await validateCodespacesSetup(codespaces, '/repo', runner);
  assert.deepEqual(evidence, { repository: 'owner/repo', requestedRef: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' });
  assert.deepEqual(calls, [
    ['git', 'remote', 'get-url', 'origin'],
    ['gh', 'api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/repos/owner/repo/commits/refs%2Fheads%2Fmain'],
    ['gh', 'api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/repos/owner/repo/contents/.devcontainer%2Fdevcontainer.json?ref=0123456789012345678901234567890123456789'],
  ]);
});

test('Codespaces setup validation rejects a local-only ref and non-regular Dev Container content', async () => {
  const runner: ProcessRunner = { async run(command, args) {
    if (command === 'git') return { code: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' };
    if (args.at(-1)?.includes('/commits/')) return { code: 1, stdout: '', stderr: 'Not Found' };
    return { code: 0, stdout: '{"type":"symlink","sha":"abcdefabcdefabcdefabcdefabcdefabcdefabcd"}', stderr: '' };
  } };
  await assert.rejects(() => validateCodespacesSetup(codespaces, '/repo', runner), /not available to Codespaces/);
});

test('Codespaces preflight parser rejects every missing policy field and accepts only typed inventory', () => {
  for (const value of [null, {}, { billable_owner: { id: 1 } }, { billable_owner: { id: 1 }, machines: [] }, { billable_owner: { id: 1 }, machines: [{ name: 'basic', geos: [] }] }, { billable_owner: { id: 1 }, machines: [{ name: 'basic', geos: ['us-east'] }], ports_allowed: true }]) assert.throws(() => parseCodespacesPreflight(value));
  assert.deepEqual(parseCodespacesPreflight({ billable_owner: { id: 1 }, machines: [{ name: 'basic', geos: ['us-east'] }], ports_allowed: true, secrets_allowed: false }), { billableOwner: '1', machines: [{ name: 'basic', geos: ['us-east'] }], portsAllowed: true, secretsAllowed: false });
});

test('doctor converts missing commands, rejected runners, aborts, and timeouts into stable action-required checks', async () => {
  const rejected: ProcessRunner = { async run() { throw new Error('ENOENT'); } };
  const report = await doctor(codespaces, 'codespaces', rejected, '/repo', { timeoutMs: 1 });
  assert.equal(report.overall, 'action-required');
  assert.equal(report.checks.find((check) => check.id === 'codespaces.gh')?.state, 'action-required');
  const abort = new AbortController(); abort.abort();
  const aborted = await doctor(codespaces, 'codespaces', rejected, '/repo', { abortSignal: abort.signal });
  assert.equal(aborted.overall, 'action-required');
});

test('atomic configuration save preserves the prior file on compare-and-swap conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-setup-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, 'version: 1\n');
  await assert.rejects(() => saveConfigAtomic(path, codespaces, 'wrong-hash', { durabilityAdapter: durability }), /changed concurrently/);
  assert.equal(await readFile(path, 'utf8'), 'version: 1\n');
});

test('doctor permits only read-only prerequisite commands and reports absent runtime explicitly', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) { calls.push([command, ...args]); return { code: 0, stdout: args.at(-1) === '/user' ? '{"id":1,"login":"octo"}' : args[0] === 'api' ? '{"billable_owner":{"id":"1"}}' : 'git version 2.0', stderr: '' }; } };
  const report = await doctor(codespaces, 'codespaces', runner);
  assert.equal(report.overall, 'action-required');
  assert.ok(report.checks.some((check) => check.id === 'codespaces.runtime.workspace' && check.phase === 'provisioned-runtime'));
  assert.ok(calls.every(([command, ...args]) => command === 'git' || (command === 'gh' && (args[0] === '--version' || (args[0] === 'api' && args.includes('GET'))))));
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
    saveConfigAtomic(path, codespaces, expected, { durabilityAdapter: durability }),
    saveConfigAtomic(path, alternate, expected, { durabilityAdapter: durability }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('expected-absence contenders publish at most one configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-absence-'));
  const path = join(directory, '.agent-containers.yml');
  const alternate = structuredClone(codespaces);
  alternate.backends.codespaces.machine = 'basicLinux32gb';
  const results = await Promise.allSettled([
    saveConfigAtomic(path, codespaces, null, { durabilityAdapter: durability }),
    saveConfigAtomic(path, alternate, null, { durabilityAdapter: durability }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok((await readFile(path, 'utf8')).includes('"machine"'));
});

test('configuration publication rejects invalid candidates, leaves no-change unwritten, and preserves old data on durability failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-durable-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, JSON.stringify(codespaces));
  assert.equal(await saveConfigAtomic(path, codespaces, undefined, { durabilityAdapter: durability }), 'no-change');
  await assert.rejects(() => saveConfigAtomic(path, { ...codespaces, project: {} } as unknown as CodespacesAgentContainersConfig, undefined, { durabilityAdapter: durability }), /project\.repository/);
  const broken: StateDurabilityAdapter = { ...durability, syncFile: async () => { throw new Error('sync failed'); } };
  const replacement = structuredClone(codespaces);
  replacement.backends.codespaces.machine = 'basicLinux32gb';
  await assert.rejects(() => saveConfigAtomic(path, replacement, undefined, { durabilityAdapter: broken }), /sync failed/);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(codespaces));
});

test('configuration publication recognizes equivalent YAML and JSON configurations as unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-canonical-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, `version: 2
workspace:
  worktreeRoot: worktrees
  baseBranch: main
project:
  repository: owner/repo
  ref: refs/heads/main
  expectedOid: '0123456789012345678901234567890123456789'
environment:
  devcontainerPath: .devcontainer/devcontainer.json
  devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'
backends:
  enabled: [codespaces]
  default: codespaces
  local: {}
  codespaces:
    enabled: true
    machine: null
    geo: auto
    idleTimeoutMinutes: 30
    retentionPeriodMinutes: 10080
    maxTotal: 4
    maxRunning: 2
    maxCreating: 1
    maxParallelCommandsPerWorkspace: 1
    readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }
    transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }
    ports: { allowVisibilityChanges: false, allowPublic: false }
    secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false }
`);
  const current = await readFile(path, 'utf8');
  assert.equal(await saveConfigAtomic(path, codespaces, undefined, { durabilityAdapter: durability }), 'no-change');
  assert.equal(await readFile(path, 'utf8'), current);
});

test('configuration lock waits for an active owner, aborts on deadline signal, and reclaims a proven-dead owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-owner-'));
  const path = join(directory, '.agent-containers.yml');
  const lock = `${path}.lock`;
  await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 42, operation: 'configuration-publication', token: 'owner', createdAt: '2026-01-01T00:00:00.000Z' }));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => saveConfigAtomic(path, codespaces, null, { durabilityAdapter: durability, abortSignal: abort.signal, ownerAlive: () => true }), /cancelled/);
  assert.equal(await saveConfigAtomic(path, codespaces, null, { durabilityAdapter: durability, ownerAlive: () => false }), 'saved');
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
    'codespaces.experimental', 'codespaces.gh', 'codespaces.actor', 'codespaces.repository',
    'codespaces.ref', 'codespaces.devcontainer', 'codespaces.preflight', 'codespaces.machine',
    'codespaces.geo', 'codespaces.ports', 'codespaces.secrets', 'codespaces.ssh-key',
    'codespaces.runtime.workspace',
  ]);
  assert.ok(calls.every(([command, ...args]) => (command === 'git' && args.join(' ') === 'remote get-url origin') || args[0] === '--version' || (args[0] === 'api' && args.includes('GET'))));
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
