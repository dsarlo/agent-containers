import assert from 'node:assert/strict';
import test from 'node:test';
import { execWorkspace, type ProcessRunner } from '../src/runtime.js';
import type { WorkspaceMetadata } from '../src/state.js';

const metadata: WorkspaceMetadata = {
  version: 1,
  name: 'safe-name',
  repoRoot: '/repo',
  worktree: '/repo/worktrees/safe-name',
  branch: 'agent-containers/safe-name',
  baseBranch: 'main',
  devcontainerPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('execWorkspace uses the linked-worktree mount, requires a current container ID, and inherits the terminal for agents', async () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  let saved: WorkspaceMetadata | undefined;
  const runner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'up') return { code: 0, stdout: '[info] started\n{"outcome":"success","containerId":"container-1"}\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await execWorkspace(metadata, ['sh', '-lc', 'printf "$HOME;$(whoami)"'], runner, async (next) => { saved = next; }, async () => '{}');
  assert.deepEqual(calls, [
    { command: 'devcontainer', args: ['up', '--workspace-folder', '/repo/worktrees/safe-name', '--config', '/repo/worktrees/safe-name/.devcontainer/devcontainer.json', '--log-format', 'json', '--mount-git-worktree-common-dir'], options: undefined },
    { command: 'devcontainer', args: ['exec', '--workspace-folder', '/repo/worktrees/safe-name', '--config', '/repo/worktrees/safe-name/.devcontainer/devcontainer.json', '--container-id', 'container-1', 'sh', '-lc', 'printf "$HOME;$(whoami)"'], options: { stdio: 'inherit' } },
  ]);
  assert.equal(saved?.containerId, 'container-1');
});

test('execWorkspace refuses successful up output without a terminal container ID', async () => {
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => '{}'), /containerId/);
});

test('execWorkspace does not reuse an earlier container ID when terminal JSON omits it', async () => {
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"containerId":"stale"}\n{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => '{}'), /containerId/);
});

test('execWorkspace preserves a remote command exit code', async () => {
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"container-1"}\n', stderr: '' }
        : { code: 42, stdout: '', stderr: 'remote command failed' };
    },
  };
  await assert.rejects(() => execWorkspace(metadata, ['false'], runner, async () => undefined, async () => '{}'), (error: unknown) => {
    assert.equal((error as { exitCode?: number }).exitCode, 42);
    return true;
  });
});

test('execWorkspace rejects unsupported Dev Container fields while parsing JSONC comments and strings safely', async () => {
  for (const field of ['dockerComposeFile', 'workspaceMount', 'workspaceFolder']) {
    const runner: ProcessRunner = { async run() { throw new Error('runner must not run'); } };
    const config = `// a comment containing ${field}\n{ "name": "literal // not a comment", /* block comment */ "${field}": "value" }`;
    await assert.rejects(
      () => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => config),
      new RegExp(`Agent Containers v0\\.1 does not support Dev Container ${field}`),
    );
  }
});

test('execWorkspace accepts standards-compatible JSONC comments, strings, and trailing commas', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"container-1"}\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  const config = `{
    // line comment
    "name": "literal // and /* comment markers */",
    "image": "example",
    /* block comment */
  }`;
  await execWorkspace(metadata, ['true'], runner, async () => undefined, async () => config);
  assert.equal(calls.length, 2);
});

test('execWorkspace removes exactly the untracked container when saving its ID fails', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"new-container"}\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}'),
    /state disk full.*removed untracked container new-container/s,
  );
  assert.deepEqual(calls.at(-1), { command: 'docker', args: ['rm', '-f', 'new-container'] });
});

test('execWorkspace reports both metadata and exact container cleanup failures', async () => {
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"new-container"}\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'permission denied' };
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}'),
    /state disk full.*could not remove untracked container new-container: permission denied/s,
  );
});

test('execWorkspace preserves recovery context when exact container cleanup throws', async () => {
  const runner: ProcessRunner = {
    async run(_command, args) {
      if (args[0] === 'up') return { code: 0, stdout: '{"containerId":"new-container"}\n', stderr: '' };
      throw new Error('docker executable missing');
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}'),
    /state disk full.*could not remove untracked container new-container: docker executable missing/s,
  );
});
