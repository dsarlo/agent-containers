import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeWorkspace } from '../src/workspaces.js';
import type { WorkspaceMetadata } from '../src/state.js';

const metadata: WorkspaceMetadata = { version: 1, name: 'safe', repoRoot: '/repo', worktree: '/repo/worktrees/safe', branch: 'agent-containers/safe', baseBranch: 'main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z', containerId: 'abc' };

test('removeWorkspace requires confirmation and records every safe destructive command', async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string; stdio?: string }> = [];
  const runner = { async run(command: string, args: string[], options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }) { calls.push({ command, args, ...options }); if (args[1] === 'list') return { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/agent-containers/safe\n', stderr: '' }; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'inspect') return { code: 0, stdout: '/repo/worktrees/safe\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
  await assert.rejects(() => removeWorkspace(metadata, { confirmed: false }, runner, async () => undefined, async () => undefined), /--yes/);
  await removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => undefined);
  assert.deepEqual(calls, [
    { command: 'git', args: ['worktree', 'list', '--porcelain'], cwd: '/repo' },
    { command: 'git', args: ['show-ref', '--verify', '--quiet', 'refs/heads/agent-containers/safe'], cwd: '/repo' },
    { command: 'git', args: ['merge-base', '--is-ancestor', 'agent-containers/safe', 'main'], cwd: '/repo' },
    { command: 'docker', args: ['inspect', '--format', '{{ index .Config.Labels "devcontainer.local_folder" }}', 'abc'] },
    { command: 'docker', args: ['rm', '-f', 'abc'] },
    { command: 'git', args: ['worktree', 'remove', '/repo/worktrees/safe'], cwd: '/repo' },
    { command: 'git', args: ['branch', '-D', 'agent-containers/safe'], cwd: '/repo' },
  ]);
});

test('removeWorkspace fails closed for mismatched Git or container metadata and retains state', async () => {
  for (const result of [
    { code: 0, stdout: 'worktree /repo/other\nbranch refs/heads/agent-containers/safe\n', stderr: '' },
    { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/agent-containers/safe\n', stderr: '' },
  ]) {
    let deleted = false;
    const runner = { async run(_command: string, args: string[]) { if (args[1] === 'list') return result; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'inspect') return { code: 0, stdout: '/repo/other\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
    await assert.rejects(() => removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => { deleted = true; }), /recorded (Git worktree|Dev Container)/);
    assert.equal(deleted, false);
  }
});

test('removeWorkspace keeps metadata when Docker is unavailable unless container cleanup is explicitly skipped', async () => {
  let deleted = false;
  const runner = { async run(_command: string, args: string[]) { if (args[1] === 'list') return { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/agent-containers/safe\n', stderr: '' }; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'inspect') throw Object.assign(new Error('docker missing'), { code: 'ENOENT' }); return { code: 0, stdout: '', stderr: '' }; } };
  await assert.rejects(() => removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => { deleted = true; }), /docker missing/);
  assert.equal(deleted, false);
  await removeWorkspace(metadata, { confirmed: true, skipContainerCleanup: true }, runner, async () => undefined, async () => { deleted = true; });
  assert.equal(deleted, true);
});

test('removeWorkspace reconciles each recorded resource already absent after a failed checkpoint save', async () => {
  for (const stage of ['container', 'worktree', 'branch'] as const) {
    const absent = new Set<string>();
    let failSave = true;
    const initial: WorkspaceMetadata = {
      ...metadata,
      cleanup: stage === 'container' ? undefined : stage === 'worktree' ? { container: true } : { container: true, worktree: true },
    };
    const runner = {
      async run(_command: string, args: string[]) {
        if (args[0] === 'worktree' && args[1] === 'list') return absent.has('worktree') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/agent-containers/safe\n', stderr: '' };
        if (args[0] === 'show-ref') return absent.has('branch') ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
        if (args[0] === 'inspect') return absent.has('container') ? { code: 1, stdout: '', stderr: 'No such container: abc' } : { code: 0, stdout: '/repo/worktrees/safe\n', stderr: '' };
        if (args[0] === 'rm') absent.add('container');
        if (args[0] === 'worktree' && args[1] === 'remove') absent.add('worktree');
        if (args[0] === 'branch' && args[1] === '-D') absent.add('branch');
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await assert.rejects(() => removeWorkspace(initial, { confirmed: true }, runner, async () => { if (failSave) { failSave = false; throw new Error('checkpoint failed'); } }, async () => undefined), /checkpoint failed/);
    await removeWorkspace(initial, { confirmed: true }, runner, async () => undefined, async () => undefined);
    assert.equal(absent.has(stage), true, `${stage} is reconciled as an already-completed destructive action`);
  }
});

test('removeWorkspace refuses to forget an unregistered worktree directory', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'agent-containers-orphaned-worktree-'));
  const orphaned: WorkspaceMetadata = { ...metadata, worktree };
  const runner = {
    async run(_command: string, args: string[]) {
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: '', stderr: '' };
      throw new Error('must not continue after unregistered directory detection');
    },
  };
  let removedMetadata = false;
  await assert.rejects(
    () => removeWorkspace(orphaned, { confirmed: true }, runner, async () => undefined, async () => { removedMetadata = true; }),
    /no longer registers.*path still exists/s,
  );
  assert.equal(removedMetadata, false);
});

test('removeWorkspace deletes the exact verified merged branch without Git upstream semantics', async () => {
  const calls: string[][] = [];
  const runner = { async run(_command: string, args: string[]) { calls.push(args); if (args[1] === 'list') return { code: 0, stdout: 'worktree /repo/worktrees/safe\nbranch refs/heads/agent-containers/safe\n', stderr: '' }; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'inspect') return { code: 0, stdout: '/repo/worktrees/safe\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
  await removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => undefined);
  assert.ok(calls.some((args) => args[0] === 'branch' && args[1] === '-D' && args[2] === 'agent-containers/safe'));
});
