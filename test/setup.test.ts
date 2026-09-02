import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configurationDiff, loadConfig, parseCodespacesDraft, parseConfig, saveConfigAtomic } from '../src/config.js';
import { discoverProjectSetup, doctor, validateCodespacesSetup } from '../src/setup.js';
import type { CodespacesAgentContainersConfig, ProcessRunner } from '../src/types.js';
import type { StateDurabilityAdapter } from '../src/durability.js';
import { resolveExecutionBackend } from '../src/backend.js';
import { recordManualRecovery, saveMetadata, setStateDurabilityAdapterForTesting } from '../src/state.js';

const codespaces: CodespacesAgentContainersConfig = { version: 2, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: { repository: 'owner/repo', ref: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, backends: { enabled: ['codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
const durability: StateDurabilityAdapter = { publicationMode: async () => 'strict', assertStateWriteSupport: async () => undefined, syncFile: async () => undefined, syncDirectory: async () => undefined, moveFileWriteThrough: async () => undefined };

test('v2 setup preserves safe no-machine defaults and emits a cost-sensitive diff', () => {
  assert.match(configurationDiff(null, codespaces), /machine: null/);
  assert.match(configurationDiff(null, codespaces), /cost-sensitive/);
});

test('backend resolver exposes local lifecycle semantics and phase-gates every Codespaces operation', async () => {
  assert.equal(resolveExecutionBackend('local').kind, 'local');
  const codespacesBackend = resolveExecutionBackend('codespaces');
  await assert.rejects(() => codespacesBackend.create({ name: 'safe', backend: 'codespaces' }), /phase-gated/);
  await assert.rejects(() => codespacesBackend.remove({ kind: 'codespaces', id: '1', name: 'safe', environmentId: 'env' }), /phase-gated/);
});

test('Codespaces setup validation requires remote ref, immutable commit, and a regular committed Dev Container blob', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) {
    calls.push([command, ...args]);
    if (command === 'git') return { code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
    if (args.at(-1) === '/repos/owner/repo/commits/refs%2Fheads%2Fmain') return { code: 0, stdout: '{"sha":"0123456789012345678901234567890123456789"}', stderr: '' };
    return { code: 0, stdout: '{"tree":[{"path":".devcontainer/devcontainer.json","mode":"100644","type":"blob","sha":"abcdefabcdefabcdefabcdefabcdefabcdefabcd"}]}', stderr: '' };
  } };
  const evidence = await validateCodespacesSetup(codespaces, '/repo', runner);
  assert.deepEqual(evidence, { repository: 'owner/repo', requestedRef: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' });
  assert.deepEqual(calls, [
    ['git', 'remote', 'get-url', 'origin'],
    ['gh', 'api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/repos/owner/repo/commits/refs%2Fheads%2Fmain'],
    ['gh', 'api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/repos/owner/repo/git/trees/0123456789012345678901234567890123456789?recursive=1'],
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

test('doctor converts missing commands, rejected runners, aborts, and timeouts into stable action-required checks', async () => {
  const rejected: ProcessRunner = { async run() { throw new Error('ENOENT'); } };
  const report = await doctor(codespaces, 'codespaces', rejected, '/repo', { timeoutMs: 1 });
  assert.equal(report.overall, 'action-required');
  assert.equal(report.checks.find((check) => check.id === 'codespaces.gh')?.state, 'action-required');
  const abort = new AbortController(); abort.abort();
  const aborted = await doctor(codespaces, 'codespaces', rejected, '/repo', { abortSignal: abort.signal });
  assert.equal(aborted.overall, 'action-required');
});

test('doctor returns a stable report for malformed or inconsistent configuration instead of throwing', async () => {
  const malformed = { version: 2, backends: { enabled: ['local', 'invalid'] } } as unknown as CodespacesAgentContainersConfig;
  const report = await doctor(malformed, 'both', { async run() { throw new Error('must not probe malformed configuration'); } }, '/repo');
  assert.deepEqual(report.selectedBackends, []);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.overall, 'action-required');
  assert.deepEqual(report.checks.map((check) => check.id), ['configuration']);
});

test('project discovery accepts one committed regular Dev Container and rejects ambiguity', async () => {
  const runner: ProcessRunner = { async run(command, args) {
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { code: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' };
    if (command === 'git' && args.join(' ') === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') return { code: 0, stdout: 'origin/main\n', stderr: '' };
    if (command === 'git' && args.join(' ') === 'rev-parse --verify refs/remotes/origin/main^{commit}') return { code: 0, stdout: '0123456789012345678901234567890123456789\n', stderr: '' };
    if (command === 'git' && args[0] === 'ls-tree') return { code: 0, stdout: '100644 blob 0123456789012345678901234567890123456789\t.devcontainer/devcontainer.json\0', stderr: '' };
    throw new Error(`${command} ${args.join(' ')}`);
  } };
  assert.deepEqual(await discoverProjectSetup('/repo', runner), { repository: 'owner/repo', ref: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789', devcontainerPath: '.devcontainer/devcontainer.json' });
  const ambiguous: ProcessRunner = { async run(command, args) {
    const result = await runner.run(command, args);
    return args[0] === 'ls-tree' ? { ...result, stdout: '100644 blob 0123456789012345678901234567890123456789\t.devcontainer/devcontainer.json\0' + '100644 blob abcdefabcdefabcdefabcdefabcdefabcdefabcd\t.devcontainer.json\0' } : result;
  } };
  await assert.rejects(() => discoverProjectSetup('/repo', ambiguous), /exactly one/i);
});

test('local doctor accepts Git worktree capability from bounded help output when Git exits 129', async () => {
  const runner: ProcessRunner = { async run(command, args) {
    if (command === 'git' && args.join(' ') === 'worktree add -h') return { code: 129, stdout: '', stderr: 'usage: git worktree add [--relative-paths] <path>' };
    return { code: 0, stdout: args.join(' ') === 'rev-parse --is-inside-work-tree' ? 'true\n' : 'git version 2', stderr: '' };
  } };
  const report = await doctor({ version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, 'local', runner);
  assert.equal(report.checks.find((check) => check.id === 'local.worktree')?.state, 'ready');
});

test('local doctor accepts worktree help only for Git help exits 0 or 129', async () => {
  const config = { version: 1 as const, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} };
  for (const code of [0, 129]) {
    const report = await doctor(config, 'local', { async run(command, args) {
      if (command === 'git' && args.join(' ') === 'worktree add -h') return { code, stdout: '--relative-paths', stderr: '' };
      return { code: 0, stdout: args.join(' ') === 'rev-parse --is-inside-work-tree' ? 'true\n' : 'available', stderr: '' };
    } });
    assert.equal(report.checks.find((check) => check.id === 'local.worktree')?.state, 'ready');
  }
  for (const code of [1, 2]) {
    const report = await doctor(config, 'local', { async run(command, args) {
      if (command === 'git' && args.join(' ') === 'worktree add -h') return { code, stdout: '--relative-paths', stderr: '' };
      return { code: 0, stdout: args.join(' ') === 'rev-parse --is-inside-work-tree' ? 'true\n' : 'available', stderr: '' };
    } });
    assert.equal(report.checks.find((check) => check.id === 'local.worktree')?.state, 'action-required');
  }
});

test('atomic configuration save preserves the prior file on compare-and-swap conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-setup-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, 'version: 1\n');
  await assert.rejects(() => saveConfigAtomic(path, codespaces, 'wrong-hash', { durabilityAdapter: durability }), /changed concurrently/);
  assert.equal(await readFile(path, 'utf8'), 'version: 1\n');
});

test('doctor permits only read-only prerequisite commands without claiming runtime coverage', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) { calls.push([command, ...args]); return { code: 0, stdout: args.at(-1) === '/user' ? '{"id":1,"login":"octo"}' : args[0] === 'api' ? '{"billable_owner":{"id":"1"}}' : 'git version 2.0', stderr: '' }; } };
  const report = await doctor(codespaces, 'codespaces', runner);
  assert.equal(report.overall, 'action-required');
  assert.ok(report.checks.every((check) => check.phase === 'pre-provision'));
  assert.ok(calls.every(([command, ...args]) => command === 'git' || (command === 'gh' && (args[0] === '--version' || (args[0] === 'api' && args.includes('GET'))))));
});

test('strict v2 rejects secret-shaped fields and incomplete Codespaces repository selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-v2-'));
  const path = join(directory, 'config.yml');
  await writeFile(path, JSON.stringify({ ...codespaces, project: {}, token: 'not-allowed' }));
  await assert.rejects(() => loadConfig(path), /unknown key \[redacted\]/);
  await writeFile(path, JSON.stringify(codespaces));
  await assert.doesNotReject(() => loadConfig(path));
  assert.throws(() => parseConfig(JSON.stringify({ ...codespaces, project: { repository: 'owner/repo' } })), /project\.ref is required/);
  assert.throws(() => parseConfig(JSON.stringify({ ...codespaces, project: { ref: 'refs/heads/main' } })), /project\.repository is required/);
});

test('configuration rejects and redacts free-form, legacy, and split credential arguments', () => {
  const legacy = { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: { deploy: 'curl -H "Authorization: Bearer secret-value"' } };
  assert.throws(() => parseConfig(JSON.stringify(legacy)), (error: Error) => !error.message.includes('secret-value'));
  const split = structuredClone(codespaces);
  split.backends.codespaces.readiness.command = ['curl', '--token', 'not-token-shaped'];
  assert.throws(() => parseConfig(JSON.stringify(split)), (error: Error) => !error.message.includes('not-token-shaped'));
  assert.doesNotMatch(configurationDiff(codespaces, codespaces), /secret-value/);
});

test('configuration rejects compound credential argv and never exposes malformed YAML source', () => {
  for (const flag of ['--token', '--access-token', '--client-secret', '--auth-token', '--oauth-token', '--credentials', '--private-key', '--auth-token=sentinel-secret-value', '--oauth-token=sentinel-secret-value', '--private-key=sentinel-secret-value']) {
    const candidate = structuredClone(codespaces);
    candidate.backends.codespaces.readiness.command = flag.includes('=') ? ['tool', flag] : ['tool', flag, 'sentinel-secret-value'];
    assert.throws(() => parseConfig(JSON.stringify(candidate)), (error: Error) => !error.message.includes('sentinel-secret-value'));
  }
  assert.throws(() => parseConfig('commands:\n  run: --token sentinel-secret-value\n  broken: [\n'), (error: Error) => !error.message.includes('sentinel-secret-value'));
  const preview = configurationDiff(null, { ...codespaces, project: { ...codespaces.project, repository: 'token: sentinel-secret-value' } } as unknown as CodespacesAgentContainersConfig);
  assert.doesNotMatch(preview, /sentinel-secret-value/);
});

test('YAML syntax diagnostics reveal only sanitized locations for direct, file, and CLI input', async () => {
  const sentinel = 'UNKNOWN_SOURCE_SENTINEL';
  const malformed = `commands:\n  ${sentinel}: [\n`;
  for (const parseSource of [() => parseConfig(malformed), () => parseCodespacesDraft(malformed)]) {
    assert.throws(parseSource, (error: Error) => /^Invalid .*syntax at line \d+, column \d+\.$/.test(error.message) && !error.message.includes(sentinel));
  }
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-yaml-diagnostic-'));
  const path = join(directory, 'bad.yml');
  await writeFile(path, malformed);
  await assert.rejects(() => loadConfig(path), (error: Error) => /^Invalid configuration syntax at line \d+, column \d+\.$/.test(error.message) && !error.message.includes(sentinel));
});

test('configuration previews retain nonsecret Codespaces secret policy while redacting values', () => {
  const candidate = structuredClone(codespaces);
  candidate.backends.codespaces.secrets = { allowedRemoteSecretNames: ['DEPLOY_TOKEN'], allowCodespaceGitCredential: true };
  const preview = configurationDiff(null, candidate);
  assert.match(preview, /allowedRemoteSecretNames/);
  assert.match(preview, /DEPLOY_TOKEN/);
  assert.match(preview, /allowCodespaceGitCredential/);
});

test('strict v2 only accepts full 40 or 64 character OIDs and rejects visibility changes', () => {
  for (const length of [39, 41, 63, 65]) {
    const invalid = structuredClone(codespaces);
    invalid.project.expectedOid = 'a'.repeat(length);
    assert.throws(() => parseConfig(JSON.stringify(invalid)), /full Git object ID/);
  }
  const sha256 = structuredClone(codespaces);
  sha256.project.expectedOid = 'a'.repeat(64);
  sha256.environment.devcontainerBlobOid = 'b'.repeat(64);
  assert.doesNotThrow(() => parseConfig(JSON.stringify(sha256)));
  const visibility = structuredClone(codespaces);
  visibility.backends.codespaces.ports.allowVisibilityChanges = true;
  assert.throws(() => parseConfig(JSON.stringify(visibility)), /visibility changes.*unsupported/);
});

test('doctor reports persisted immutable evidence drift as action-required', async () => {
  const runner: ProcessRunner = { async run(command, args) {
    if (command === 'git') return { code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2', stderr: '' };
    if (args.at(-1) === '/user') return { code: 0, stdout: '{"id":"1","login":"octo"}', stderr: '' };
    if (args.at(-1)?.includes('/commits/')) return { code: 0, stdout: '{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', stderr: '' };
    if (args.at(-1)?.includes('/contents/')) return { code: 0, stdout: '{"type":"file","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}', stderr: '' };
    if (args.at(-1)?.includes('/machines')) return { code: 0, stdout: '{"total_count":1,"machines":[{"name":"basic","display_name":"Basic","operating_system":"linux","storage_in_bytes":1,"memory_in_bytes":1,"cpus":1,"prebuild_availability":null}]}', stderr: '' };
    return { code: 0, stdout: '{"billable_owner":{"id":"1","login":"octo"},"defaults":{"location":"WestUs2","devcontainer_path":null}}', stderr: '' };
  } };
  const report = await doctor(codespaces, 'codespaces', runner, '/repo');
  assert.equal(report.checks.find((check) => check.id === 'codespaces.ref')?.state, 'action-required');
  assert.equal(report.checks.find((check) => check.id === 'codespaces.devcontainer')?.state, 'action-required');
});

test('local doctor reports a no-container workspace with every manual recovery reason as possibly active', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-doctor-recovery-')), 'state');
  const root = '/repo';
  setStateDurabilityAdapterForTesting(durability);
  try {
    for (const reason of ['operation-may-be-active', 'remote-exec-interrupted', 'devcontainer-up-ambiguous', 'local-process-reap-unconfirmed'] as const) {
      const name = `safe-${reason.replaceAll('-', '').slice(0, 12)}`;
      await saveMetadata(stateDir, { version: 1, name, repoRoot: root, worktree: `${root}/worktrees/${name}`, branch: `agent-containers/${name}`, baseRef: 'refs/heads/main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z' });
      await recordManualRecovery(stateDir, name, { reason, containerIds: [], worktree: `${root}/worktrees/${name}` });
      const report = await doctor({ version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, 'local', { async run(_command, args) { return { code: 0, stdout: args[0] === 'rev-parse' ? `${root}\n` : '--relative-paths\n', stderr: '' }; } }, root, { stateDir, workspaceName: name });
      const recovery = report.checks.find((check) => check.id === 'local.workspace.recovery');
      assert.equal(recovery?.state, 'action-required');
      assert.match(recovery?.summary ?? '', /may still be active/);
    }
  } finally { setStateDurabilityAdapterForTesting(undefined); }
});

test('v2 setup drafts may omit discovered evidence, while persisted v2 configurations may not', () => {
  const draft = structuredClone(codespaces);
  delete draft.project.expectedOid;
  delete draft.environment.devcontainerBlobOid;
  const parsed = parseCodespacesDraft(JSON.stringify(draft));
  assert.equal(parsed.project.expectedOid, undefined);
  assert.equal(parsed.environment.devcontainerBlobOid, undefined);
  assert.throws(() => parseConfig(JSON.stringify(draft)), /requires validated project.expectedOid/);
});

test('cooperating expected-generation writers replace exactly one unchanged configuration', async () => {
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
  assert.ok((await readFile(path, 'utf8')).includes('"machine"'));
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

test('configuration CAS preserves a non-cooperating writer that changes the file before publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-external-race-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, JSON.stringify(codespaces));
  const expected = (await import('../src/config.js')).hashConfig(await readFile(path, 'utf8'));
  await assert.rejects(() => saveConfigAtomic(path, { ...codespaces, backends: { ...codespaces.backends, codespaces: { ...codespaces.backends.codespaces, machine: 'basicLinux32gb' } } }, expected, {
    durabilityAdapter: durability,
    beforePublish: async () => { await writeFile(path, 'external edit'); },
  }), /changed concurrently/);
  assert.equal(await readFile(path, 'utf8'), 'external edit');
});

test('expected-absence publication preserves an external writer arriving after the final check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-post-check-race-'));
  const path = join(directory, '.agent-containers.yml');
  await assert.rejects(() => saveConfigAtomic(path, codespaces, null, {
    durabilityAdapter: durability,
    afterCheckBeforePublish: async () => { await writeFile(path, 'external post-check edit'); },
  }), /changed concurrently/);
  assert.equal(await readFile(path, 'utf8'), 'external post-check edit');
});

test('discovery scans the resolved immutable OID rather than a moving tracking ref', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) {
    calls.push([command, ...args]);
    if (args[0] === 'remote') return { code: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' };
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'origin/main\n', stderr: '' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: '0123456789012345678901234567890123456789\n', stderr: '' };
    return { code: 0, stdout: '100644 blob abcdefabcdefabcdefabcdefabcdefabcdefabcd\t.devcontainer/custom.json\0', stderr: '' };
  } };
  await discoverProjectSetup('/repo', runner);
  assert.deepEqual(calls.at(-1), ['git', 'ls-tree', '-r', '-z', '0123456789012345678901234567890123456789']);
});

test('doctor returns action-required after cancellation even when a runner ignores abort', async () => {
  const abort = new AbortController();
  const runner: ProcessRunner = { async run(_command, _args, options) {
    options?.signal?.addEventListener('abort', () => undefined);
    return await new Promise<never>(() => undefined);
  } };
  setTimeout(() => abort.abort(), 5);
  const report = await Promise.race([doctor(codespaces, 'codespaces', runner, '/repo', { abortSignal: abort.signal, timeoutMs: 50 }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung')), 200))]);
  assert.equal(report.overall, 'action-required');
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

test('configuration publication reports the committed generation when final directory durability confirmation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-final-sync-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, JSON.stringify(codespaces));
  const replacement = structuredClone(codespaces);
  replacement.backends.codespaces.machine = 'basicLinux32gb';
  let directorySyncs = 0;
  const broken: StateDurabilityAdapter = { ...durability, syncDirectory: async () => { directorySyncs += 1; if (directorySyncs === 3) throw new Error('directory sync failed'); } };
  await assert.rejects(() => saveConfigAtomic(path, replacement, undefined, { durabilityAdapter: broken }), /committed configuration is present.*directory sync failed/);
  assert.deepEqual(parseConfig(await readFile(path, 'utf8')), replacement);
});

test('configuration publication preserves its committed-generation diagnostic when release durability also fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-release-sync-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, JSON.stringify(codespaces));
  const replacement = structuredClone(codespaces);
  replacement.backends.codespaces.machine = 'basicLinux32gb';
  let directorySyncs = 0;
  const broken: StateDurabilityAdapter = { ...durability, syncDirectory: async () => {
    directorySyncs += 1;
    if (directorySyncs === 3) throw new Error('publication sync failed');
    if (directorySyncs === 4) throw new Error('release sync failed');
  } };
  await assert.rejects(() => saveConfigAtomic(path, replacement, undefined, { durabilityAdapter: broken }), /committed configuration is present.*publication sync failed/);
  assert.deepEqual(parseConfig(await readFile(path, 'utf8')), replacement);
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

test('configuration lock release preserves a replacement owner in recoverable Windows publication mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-lock-replacement-'));
  const path = join(directory, '.agent-containers.yml');
  const lock = `${path}.lock`;
  let replacementPublished = false;
  const recoverable: StateDurabilityAdapter = {
    ...durability,
    publicationMode: async () => 'recoverable',
    moveFileWriteThrough: async (source, destination) => {
      await rename(source, destination);
      if (!replacementPublished && destination.endsWith('.released')) {
        replacementPublished = true;
        await mkdir(lock);
        await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 99, operation: 'configuration-publication', token: 'replacement', createdAt: '2026-01-01T00:00:00.000Z' }));
      }
    },
    moveFileNoReplaceWriteThrough: async (source, destination) => { await rename(source, destination); },
  };
  assert.equal(await saveConfigAtomic(path, codespaces, null, { durabilityAdapter: recoverable }), 'saved');
  assert.match(await readFile(join(lock, 'owner.json'), 'utf8'), /replacement/);
});

test('doctor has a stable complete Codespaces inventory and uses only its positive read allowlist', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(command, args) {
    calls.push([command, ...args]);
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2', stderr: '' };
    if (args.at(-1) === '/user') return { code: 0, stdout: '{"id":"1","login":"octo"}', stderr: '' };
    return { code: 0, stdout: '{"total_count":1,"machines":[{"name":"basic"}]}', stderr: '' };
  } };
  const report = await doctor(codespaces, 'codespaces', runner);
  assert.deepEqual(report.checks.map((check) => check.id), [
    'codespaces.experimental', 'codespaces.gh', 'codespaces.actor', 'codespaces.repository',
    'codespaces.ref', 'codespaces.devcontainer', 'codespaces.owner-billing', 'codespaces.machine',
    'codespaces.geo', 'codespaces.ports', 'codespaces.secrets', 'codespaces.ssh-key',
  ]);
  assert.ok(calls.every(([command, ...args]) => (command === 'git' && args.join(' ') === 'remote get-url origin') || args[0] === '--version' || (args[0] === 'api' && args.includes('GET'))));
  assert.ok(calls.every((call) => !call.join(' ').match(/ auth | token|create|start|stop|delete|ssh|secret|port/i)));
  assert.ok(report.checks.filter((check) => check.state !== 'ready').every((check) => check.remediation.at(-1)?.startsWith('Run ac doctor')));
});

test('doctor never marks configured repository facts ready when documented machine inventory is malformed', async () => {
  const runner: ProcessRunner = { async run(_command, args) {
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2', stderr: '' };
    if (args.at(-1) === '/user') return { code: 0, stdout: '{"id":"1","login":"octo"}', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  } };
  const report = await doctor(codespaces, 'codespaces', runner);
  for (const id of ['codespaces.repository', 'codespaces.ref', 'codespaces.devcontainer', 'codespaces.machine']) {
    assert.notEqual(report.checks.find((check) => check.id === id)?.state, 'ready', `${id} requires provider evidence`);
  }
});
