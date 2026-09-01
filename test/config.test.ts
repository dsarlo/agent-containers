import assert from 'node:assert/strict';
import { lstat, link, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CONFIG_OUTLINE, assertDevcontainerPathCommittedOnBaseBranch, initConfig, loadConfig } from '../src/config.js';
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

test('initConfig force-replaces only its own hard link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const external = join(directory, 'external.yml');
  const path = join(directory, '.agent-containers.yml');
  await writeFile(external, 'external contents\n');
  await link(external, path);

  await initConfig(directory, true);

  assert.equal(await readFile(external, 'utf8'), 'external contents\n');
  assert.equal(await readFile(path, 'utf8'), CONFIG_OUTLINE);
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
  assert.equal((await loadConfig(path)).commands['any-user-defined-name'], 'npm test');
});
