import assert from 'node:assert/strict';
import test from 'node:test';
import { removeWorkspace } from '../src/workspaces.js';
import type { WorkspaceMetadata } from '../src/state.js';

const metadata: WorkspaceMetadata = { version: 1, name: 'safe', repoRoot: '/repo', worktree: '/repo/worktrees/safe', branch: 'arachne/safe', baseBranch: 'main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z', containerId: 'abc' };

test('removeWorkspace requires confirmation and records every safe destructive command', async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string; stdio?: string }> = [];
  const runner = { async run(command: string, args: string[], options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }) { calls.push({ command, args, ...options }); if (args[1] === 'list') return { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/arachne/safe\n', stderr: '' }; if (args[0] === 'inspect') return { code: 0, stdout: '/repo/worktrees/safe\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
  await assert.rejects(() => removeWorkspace(metadata, { confirmed: false }, runner, async () => undefined, async () => undefined), /--yes/);
  await removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => undefined);
  assert.deepEqual(calls, [
    { command: 'git', args: ['worktree', 'list', '--porcelain'], cwd: '/repo' },
    { command: 'git', args: ['merge-base', '--is-ancestor', 'arachne/safe', 'main'], cwd: '/repo' },
    { command: 'docker', args: ['inspect', '--format', '{{ index .Config.Labels "devcontainer.local_folder" }}', 'abc'] },
    { command: 'docker', args: ['rm', '-f', 'abc'] },
    { command: 'git', args: ['worktree', 'remove', '/repo/worktrees/safe'], cwd: '/repo' },
    { command: 'git', args: ['branch', '-d', 'arachne/safe'], cwd: '/repo' },
  ]);
});

test('removeWorkspace fails closed for mismatched Git or container metadata and retains state', async () => {
  for (const result of [
    { code: 0, stdout: 'worktree /repo/other\nbranch refs/heads/arachne/safe\n', stderr: '' },
    { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/arachne/safe\n', stderr: '' },
  ]) {
    let deleted = false;
    const runner = { async run(_command: string, args: string[]) { if (args[1] === 'list') return result; if (args[0] === 'inspect') return { code: 0, stdout: '/repo/other\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
    await assert.rejects(() => removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => { deleted = true; }), /recorded (Git worktree|Dev Container)/);
    assert.equal(deleted, false);
  }
});

test('removeWorkspace keeps metadata when Docker is unavailable unless container cleanup is explicitly skipped', async () => {
  let deleted = false;
  const runner = { async run(_command: string, args: string[]) { if (args[1] === 'list') return { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/arachne/safe\n', stderr: '' }; if (args[0] === 'inspect') throw Object.assign(new Error('docker missing'), { code: 'ENOENT' }); return { code: 0, stdout: '', stderr: '' }; } };
  await assert.rejects(() => removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => { deleted = true; }), /docker missing/);
  assert.equal(deleted, false);
  await removeWorkspace(metadata, { confirmed: true, skipContainerCleanup: true }, runner, async () => undefined, async () => { deleted = true; });
  assert.equal(deleted, true);
});
