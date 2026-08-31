import assert from 'node:assert/strict';
import { lstat, link, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CONFIG_OUTLINE, initConfig, loadConfig } from '../src/config.js';

test('initConfig writes the public config outline and refuses overwrite by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-config-'));
  const path = join(directory, '.agent-containers.yml');

  await initConfig(directory);
  assert.equal(await readFile(path, 'utf8'), CONFIG_OUTLINE);
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
