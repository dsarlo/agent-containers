import assert from 'node:assert/strict';
import { lstat, link, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CONFIG_OUTLINE, assertDevcontainerPathCommittedOnBaseBranch, hashConfig, initConfig, initConfigV2, loadConfig, parseCodespacesDraft, parseConfig, saveConfigAtomic, snapshotInitConfig } from '../src/config.js';
import type { AgentContainersConfig, ProcessRunner } from '../src/types.js';

test('base-branch Dev Container validation uses a safe Git path through the injected runner', async () => {
  const config: AgentContainersConfig = {
    version: 1,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json' },
    commands: {},
  };
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options?.cwd });
      return { code: 0, stdout: args[0] === 'ls-tree' ? '100644 blob 0123456789012345678901234567890123456789\t.devcontainer/devcontainer.json\0' : '', stderr: '' };
    },
  };

  await assertDevcontainerPathCommittedOnBaseBranch(config, '/repo', runner);

  assert.deepEqual(calls, [
    { command: 'git', args: ['show-ref', '--verify', '--quiet', 'refs/heads/main'], cwd: '/repo' },
    { command: 'git', args: ['ls-tree', '-z', 'refs/heads/main', '--', '.devcontainer/devcontainer.json'], cwd: '/repo' },
  ]);
});

test('lifecycle base-branch validation passes its abort signal to both Git commands', async () => {
  const config: AgentContainersConfig = {
    version: 1,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json' },
    commands: {},
  };
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const runner: ProcessRunner = {
    async run(_command, args, options) {
      assert.equal(options?.kind, 'lifecycle');
      assert.equal(options?.signal, controller.signal);
      signals.push(options?.signal as AbortSignal);
      return { code: 0, stdout: args[0] === 'ls-tree' ? '100644 blob 0123456789012345678901234567890123456789\t.devcontainer/devcontainer.json\0' : '', stderr: '' };
    },
  };

  await assertDevcontainerPathCommittedOnBaseBranch(config, '/repo', runner, undefined, 'lifecycle', controller.signal);
  assert.deepEqual(signals, [controller.signal, controller.signal]);
});

test('base-branch Dev Container validation rejects a committed symlink from Git tree metadata', async () => {
  const config: AgentContainersConfig = {
    version: 1,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json' },
    commands: {},
  };
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      return {
        code: 0,
        stdout: args[0] === 'ls-tree' ? '120000 blob 0123456789012345678901234567890123456789\t.devcontainer/devcontainer.json\0' : '',
        stderr: '',
      };
    },
  };

  await assert.rejects(
    () => assertDevcontainerPathCommittedOnBaseBranch(config, '/repo', runner),
    /environment\.devcontainerPath.*regular non-symlink file.*base branch "main"/s,
  );
  assert.deepEqual(calls, [
    ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
    ['ls-tree', '-z', 'refs/heads/main', '--', '.devcontainer/devcontainer.json'],
  ]);
});

test('base-branch Dev Container validation gives a remediation for an untracked config and rejects unsafe paths', async () => {
  const config: AgentContainersConfig = {
    version: 1,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json' },
    commands: {},
  };
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      if (args[0] === 'ls-tree') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await assert.rejects(
    () => assertDevcontainerPathCommittedOnBaseBranch(config, '/repo', runner),
    /environment\.devcontainerPath.*must be committed to.*base branch.*or copied into the worktree/s,
  );
  await assert.rejects(
    () => assertDevcontainerPathCommittedOnBaseBranch({ ...config, environment: { devcontainerPath: '../outside.json' } }, '/repo', runner),
    /environment\.devcontainerPath must be a safe repository-relative path/,
  );
  assert.equal(calls.length, 2, 'unsafe paths are rejected before Git is invoked');
});

test('initConfig writes the public config outline and refuses overwrite by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const path = join(directory, '.agent-containers.yml');

  await initConfig(directory);
  assert.equal(await readFile(path, 'utf8'), CONFIG_OUTLINE);
  assert.match(CONFIG_OUTLINE, /worktreeRoot: \.\.\/\.agent-containers-worktrees/);
  assert.match(CONFIG_OUTLINE, /devcontainerPath.*repository-relative|repository-relative.*devcontainerPath/s);
  assert.doesNotMatch(CONFIG_OUTLINE, /All paths are relative to the source repository unless absolute/);
  await assert.rejects(() => initConfig(directory), /already exists/);

  await initConfig(directory, true);
  assert.equal(await readFile(path, 'utf8'), CONFIG_OUTLINE);
});

test('loadConfig applies documented defaults and validates useful errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const path = join(directory, 'config.yml');
  await writeFile(path, 'version: 1\n');

  const config = await loadConfig(path);
  assert.equal(config.workspace.worktreeRoot, '../.agent-containers-worktrees');
  assert.equal(config.workspace.baseBranch, 'main');
  assert.equal(config.environment.devcontainerPath, '.devcontainer/devcontainer.json');

  await writeFile(path, 'version: 1\nenvironment:\n  devcontainerPath: .devcontainer\\devcontainer.json\n');
  const normalized = await loadConfig(path);
  assert.equal(normalized.environment.devcontainerPath, '.devcontainer/devcontainer.json', 'accepted Git separators must be persisted in runtime-safe canonical form');

  await writeFile(path, 'version: 2\nworkspace:\n  baseBranch: ""\n');
  await assert.rejects(() => loadConfig(path), /version must be 1.*workspace.baseBranch must be a non-empty string/s);
});

test('initConfig never overwrites a symlink, including with --force', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const external = join(directory, 'external.yml');
  const path = join(directory, '.agent-containers.yml');
  await writeFile(external, 'external contents\n');
  try {
    await symlink(external, path);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
      t.skip('symlinks are unavailable on this filesystem');
      return;
    }
    throw error;
  }
  await assert.rejects(() => initConfig(directory, true), /symlink/);
  assert.equal(await readFile(external, 'utf8'), 'external contents\n');
  assert.equal((await lstat(path)).isSymbolicLink(), true);
});

test('initConfigV2 never replaces a dangling configuration symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-v2-symlink-'));
  const path = join(directory, '.agent-containers.yml');
  await symlink(join(directory, 'missing.yml'), path);
  const config = { version: 2 as const, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: {}, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, backends: { enabled: ['local' as const], default: 'local' as const, local: {}, codespaces: { enabled: false, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
  await assert.rejects(() => initConfigV2(directory, config), /symlink/);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
});

test('initConfig force refuses a hard-linked configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const external = join(directory, 'external.yml');
  const path = join(directory, '.agent-containers.yml');
  await writeFile(external, 'external contents\n');
  await link(external, path);

  await assert.rejects(() => initConfig(directory, true), /multiple hard links/);

  assert.equal(await readFile(external, 'utf8'), 'external contents\n');
  assert.equal(await readFile(path, 'utf8'), 'external contents\n');
});

test('force onboarding snapshots the original file before confirmation and refuses an intervening change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-init-snapshot-'));
  const path = join(directory, '.agent-containers.yml');
  await writeFile(path, 'version: 1\n');
  const snapshot = await snapshotInitConfig(directory, true);
  assert.equal(snapshot.expectedHash, hashConfig('version: 1\n'));
  assert.equal(snapshot.current?.version, 1);
  await writeFile(path, 'intervening content\n');
  const config = {
    version: 2 as const,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: {}, environment: { devcontainerPath: '.devcontainer/devcontainer.json' },
    backends: { enabled: ['local' as const], default: 'local' as const, local: {}, codespaces: {
      enabled: false, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1,
      readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 },
      transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 },
      ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false },
    } },
  };
  await assert.rejects(() => initConfigV2(directory, config, true, snapshot.expectedHash), /changed concurrently/);
  assert.equal(await readFile(path, 'utf8'), 'intervening content\n');
});

test('force onboarding hashes malformed raw bytes and can replace them only under that exact CAS generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-init-malformed-snapshot-'));
  const path = join(directory, '.agent-containers.yml');
  const malformed = 'commands:\n  SNAPSHOT_SECRET_SENTINEL: [\n';
  await writeFile(path, malformed);
  const snapshot = await snapshotInitConfig(directory, true);
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.expectedHash, hashConfig(malformed));
  const config = { version: 2 as const, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: {}, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, backends: { enabled: ['local' as const], default: 'local' as const, local: {}, codespaces: { enabled: false, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 1, remoteLogRetentionHours: 1 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
  await initConfigV2(directory, config, true, snapshot.expectedHash);
  assert.equal(parseConfig(await readFile(path, 'utf8')).version, 2);
});

test('loadConfig rejects wrong-shaped roots and sections instead of defaulting them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const path = join(directory, 'config.yml');
  for (const source of ['[]\n', 'workspace: []\n', 'environment: null\n', 'commands: []\n']) {
    await writeFile(path, source);
    await assert.rejects(() => loadConfig(path), /must be an object/);
  }
});

test('loadConfig rejects unknown schema keys while allowing arbitrary command names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const path = join(directory, 'config.yml');
  for (const source of [
    'versoin: 1\n',
    'workspace:\n  baseBrnch: main\n',
    'environment:\n  devcontainerPth: x\n',
  ]) {
    await writeFile(path, source);
    await assert.rejects(() => loadConfig(path), /unknown key/);
  }
  await writeFile(path, 'commands:\n  any-user-defined-name: npm test\n');
  const config = await loadConfig(path);
  assert.equal(config.version, 1);
  if (config.version !== 1) throw new Error('expected legacy local configuration');
  assert.equal(config.commands['any-user-defined-name'], 'npm test');
});

test('Codespaces setup rejects secret-shaped freeform values before preview or persistence', async () => {
  const candidate = {
    version: 2,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    project: { repository: 'owner/repo', ref: 'refs/heads/main' },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json' },
    backends: { enabled: ['codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: ['curl', 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890'], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } },
  };
  assert.throws(() => parseCodespacesDraft(JSON.stringify(candidate)), /secret-shaped/i);
});

test('Codespaces secret policy rejects token-shaped identifiers before persistence while retaining capability names', () => {
  const candidate = { version: 2, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: { repository: 'owner/repo', ref: 'refs/heads/main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, backends: { enabled: ['codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 1, remoteLogRetentionHours: 1 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: ['DEPLOY_TOKEN'], allowCodespaceGitCredential: false } } } };
  assert.doesNotThrow(() => parseCodespacesDraft(JSON.stringify(candidate)));
  candidate.backends.codespaces.secrets.allowedRemoteSecretNames = ['github_pat_abcdefghijklmnopqrstuvwxyz1234567890'];
  assert.throws(() => parseCodespacesDraft(JSON.stringify(candidate)), (error: Error) => !error.message.includes('github_pat_'));
});

test('legacy command names reject credential-shaped identifiers without exposing them', () => {
  const key = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
  assert.throws(() => parseConfig(`version: 1\ncommands:\n  ${key}: npm test\n`), (error: Error) => !error.message.includes(key));
});

test('Codespaces setup rejects split curl Authorization headers without exposing their value', () => {
  const candidate = { version: 2, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: { repository: 'owner/repo', ref: 'refs/heads/main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, backends: { enabled: ['codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: ['curl', '-H', 'Authorization:', 'Bearer', 'not-token-shaped'], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
  assert.throws(() => parseCodespacesDraft(JSON.stringify(candidate)), (error: Error) => /credential header/.test(error.message) && !error.message.includes('not-token-shaped'));
});

test('equivalent canonical config returns no-change without durability or lock writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-no-change-'));
  const path = join(directory, '.agent-containers.yml');
  const config = { version: 2 as const, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: {}, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, backends: { enabled: ['local' as const], default: 'local' as const, local: {}, codespaces: { enabled: false, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  const before = await stat(path);
  const result = await saveConfigAtomic(path, config, undefined, { durabilityAdapter: { assertStateWriteSupport: async () => { throw new Error('must not write'); }, publicationMode: async () => 'strict', syncFile: async () => undefined, syncDirectory: async () => undefined, moveFileWriteThrough: async () => undefined } });
  assert.equal(result, 'no-change');
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
});
