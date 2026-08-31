import assert from 'node:assert/strict';
import test from 'node:test';
import { execWorkspace, type ProcessRunner } from '../src/runtime.js';
import type { WorkspaceMetadata } from '../src/state.js';

const metadata: WorkspaceMetadata = {
  version: 1,
  name: 'safe-name',
  repoRoot: '/repo',
  worktree: '/repo/worktrees/safe-name',
  branch: 'arachne/safe-name',
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

  await execWorkspace(metadata, ['sh', '-lc', 'printf "$HOME;$(whoami)"'], runner, async (next) => { saved = next; });
  assert.deepEqual(calls, [
    { command: 'devcontainer', args: ['up', '--workspace-folder', '/repo/worktrees/safe-name', '--config', '/repo/worktrees/safe-name/.devcontainer/devcontainer.json', '--log-format', 'json', '--mount-git-worktree-common-dir'], options: undefined },
    { command: 'devcontainer', args: ['exec', '--workspace-folder', '/repo/worktrees/safe-name', '--config', '/repo/worktrees/safe-name/.devcontainer/devcontainer.json', '--container-id', 'container-1', 'sh', '-lc', 'printf "$HOME;$(whoami)"'], options: { stdio: 'inherit' } },
  ]);
  assert.equal(saved?.containerId, 'container-1');
});

test('execWorkspace refuses successful up output without a terminal container ID', async () => {
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined), /containerId/);
});

test('execWorkspace does not reuse an earlier container ID when terminal JSON omits it', async () => {
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"containerId":"stale"}\n{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined), /containerId/);
});

test('execWorkspace preserves a remote command exit code', async () => {
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"container-1"}\n', stderr: '' }
        : { code: 42, stdout: '', stderr: 'remote command failed' };
    },
  };
  await assert.rejects(() => execWorkspace(metadata, ['false'], runner, async () => undefined), (error: unknown) => {
    assert.equal((error as { exitCode?: number }).exitCode, 42);
    return true;
  });
});
