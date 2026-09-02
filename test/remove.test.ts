import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { removeWorkspace, UnconfirmedProcessReapError } from '../src/workspaces.js';
import { bootstrapManualRecoveryJournal, loadManualRecovery, recordManualRecovery, withWorkspaceLock, type WorkspaceMetadata } from '../src/state.js';

const containerId = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const repoRoot = resolve(tmpdir(), 'agent-containers-remove-repo');
const worktree = join(repoRoot, 'worktrees', 'safe');
const worktreeListing = `worktree ${worktree}\nbranch refs/heads/agent-containers/safe\n`;
const inspection = `${containerId}\n${worktree}\n`;
const metadata: WorkspaceMetadata = { version: 1, name: 'safe', repoRoot, worktree, branch: 'agent-containers/safe', baseRef: 'refs/heads/main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z', containerId };

test('removeWorkspace requires confirmation and records every safe destructive command', async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string; stdio?: string }> = [];
  const runner = { async run(command: string, args: string[], options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }) { calls.push({ command, args, ...options }); if (args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' }; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }; if (args[0] === 'inspect') return { code: 0, stdout: inspection, stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
  await assert.rejects(() => removeWorkspace(metadata, { confirmed: false }, runner, async () => undefined, async () => undefined), /--yes/);
  await removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => undefined);
  assert.deepEqual(calls, [
    { command: 'git', args: ['worktree', 'list', '--porcelain'], cwd: repoRoot },
    { command: 'git', args: ['show-ref', '--verify', '--quiet', 'refs/heads/agent-containers/safe'], cwd: repoRoot },
    { command: 'git', args: ['rev-parse', '--verify', 'refs/heads/agent-containers/safe'], cwd: repoRoot },
    { command: 'git', args: ['rev-parse', '--verify', 'refs/heads/main'], cwd: repoRoot },
    { command: 'git', args: ['merge-base', '--is-ancestor', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], cwd: repoRoot },
    { command: 'git', args: ['status', '--porcelain=v1', '--untracked-files=all'], cwd: worktree },
    { command: 'docker', args: ['inspect', '--format', '{{.Id}}\n{{ index .Config.Labels "devcontainer.local_folder" }}', containerId] },
    { command: 'docker', args: ['rm', '-f', containerId] },
    { command: 'git', args: ['worktree', 'remove', worktree], cwd: repoRoot },
    { command: 'git', args: ['update-ref', '--stdin'], cwd: repoRoot, input: 'start\nverify refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ndelete refs/heads/agent-containers/safe aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nprepare\ncommit\n' },
  ].map((call) => ({ ...call, kind: 'lifecycle' })));
});

test('remove lifecycle records durable recovery before its workspace lock releases an unconfirmed local reap', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-remove-unconfirmed-reap-'));
  await bootstrapManualRecoveryJournal(stateDir, metadata.name);
  const runner = {
    async run(_command: string, _args: string[], options?: { kind?: string }) {
      assert.equal(options?.kind, 'lifecycle');
      throw new UnconfirmedProcessReapError();
    },
  };

  await assert.rejects(
    () => withWorkspaceLock(
      stateDir,
      metadata.name,
      (signal) => removeWorkspace(metadata, { confirmed: true, signal }, runner, async () => undefined, async () => undefined),
      { onUnconfirmedProcessReap: () => recordManualRecovery(stateDir, metadata.name, { reason: 'local-process-reap-unconfirmed', containerIds: [], worktree: metadata.worktree }) },
    ),
    UnconfirmedProcessReapError,
  );
  assert.equal((await loadManualRecovery(stateDir, metadata.name))?.reason, 'local-process-reap-unconfirmed');
  await assert.rejects(() => withWorkspaceLock(stateDir, metadata.name, async () => undefined), /manual recovery/);
});

test('removeWorkspace passes --force only for the verified recorded worktree after confirmation', async () => {
  const calls: string[][] = [];
  const runner = {
    async run(_command: string, args: string[]) {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' };
      if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await removeWorkspace({ ...metadata, cleanup: { container: true } }, { confirmed: true, forceWorktree: true }, runner, async () => undefined, async () => undefined);

  assert.deepEqual(calls.find((args) => args[0] === 'worktree' && args[1] === 'remove'), ['worktree', 'remove', '--force', worktree]);
});

test('removeWorkspace refuses a dirty worktree before deleting its owned container', async () => {
  const calls: string[][] = [];
  const runner = {
    async run(_command: string, args: string[]) {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' };
      if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: '?? important-output.txt\n', stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: inspection, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await assert.rejects(
    () => removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => undefined),
    /ac remove safe --yes --force-worktree/,
  );
  assert.equal(calls.some((args) => args[0] === 'rm'), false, 'dirty-worktree refusal must not destroy its owned container first');
  assert.equal(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'), false);
});

test('removeWorkspace names the opt-in remediation when Git refuses a dirty worktree', async () => {
  const runner = {
    async run(_command: string, args: string[]) {
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' };
      if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { code: 128, stdout: '', stderr: 'contains modified or untracked files, use --force to delete it' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await assert.rejects(
    () => removeWorkspace({ ...metadata, cleanup: { container: true } }, { confirmed: true }, runner, async () => undefined, async () => undefined),
    /ac remove safe --yes --force-worktree/,
  );
});

test('removeWorkspace fails closed for mismatched Git or container metadata and retains state', async () => {
  for (const result of [
    { code: 0, stdout: `worktree ${join(repoRoot, 'other')}\nbranch refs/heads/agent-containers/safe\n`, stderr: '' },
    { code: 0, stdout: worktreeListing, stderr: '' },
  ]) {
    let deleted = false;
    const runner = { async run(_command: string, args: string[]) { if (args[1] === 'list') return result; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }; if (args[0] === 'inspect') return { code: 0, stdout: `${containerId}\n${join(repoRoot, 'other')}\n`, stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
    await assert.rejects(() => removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => { deleted = true; }), /recorded (Git worktree|Dev Container)/);
    assert.equal(deleted, false);
  }
});

test('removeWorkspace keeps metadata when Docker is unavailable unless container cleanup is explicitly skipped', async () => {
  let deleted = false;
  const runner = { async run(_command: string, args: string[]) { if (args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' }; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }; if (args[0] === 'inspect') throw Object.assign(new Error('docker missing'), { code: 'ENOENT' }); return { code: 0, stdout: '', stderr: '' }; } };
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
        if (args[0] === 'worktree' && args[1] === 'list') return absent.has('worktree') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: worktreeListing, stderr: '' };
        if (args[0] === 'show-ref') return absent.has('branch') ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
        if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
        if (args[0] === 'inspect') return absent.has('container') ? { code: 1, stdout: '', stderr: `No such container: ${containerId}` } : { code: 0, stdout: inspection, stderr: '' };
        if (args[0] === 'rm') absent.add('container');
        if (args[0] === 'worktree' && args[1] === 'remove') absent.add('worktree');
        if (args[0] === 'update-ref') absent.add('branch');
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

test('removeWorkspace refuses to forget an unregistered dangling worktree symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-orphaned-worktree-link-'));
  const worktree = join(directory, 'dangling-worktree');
  await symlink(join(directory, 'missing-target'), worktree);
  const orphaned: WorkspaceMetadata = { ...metadata, worktree };
  let runnerCalled = false;
  const runner = {
    async run(_command: string, args: string[]) {
      runnerCalled = true;
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: '', stderr: '' };
      throw new Error('must not continue after dangling symlink detection');
    },
  };
  await assert.rejects(
    () => removeWorkspace(orphaned, { confirmed: true }, runner, async () => undefined, async () => undefined),
    /no longer registers.*path still exists/,
  );
  assert.equal(runnerCalled, true, 'Git registration is checked before the dangling path guard');
});

test('removeWorkspace deletes the exact verified merged branch without Git upstream semantics', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner = { async run(_command: string, args: string[], options?: { input?: string }) { calls.push({ args, input: options?.input }); if (args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' }; if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' }; if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }; if (args[0] === 'inspect') return { code: 0, stdout: inspection, stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
  await removeWorkspace(metadata, { confirmed: true }, runner, async () => undefined, async () => undefined);
  assert.deepEqual(calls.at(-1), { args: ['update-ref', '--stdin'], input: 'start\nverify refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ndelete refs/heads/agent-containers/safe aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nprepare\ncommit\n' });
});

test('removeWorkspace refuses to delete a branch that moved after its merged OID was verified', async () => {
  const calls: string[][] = [];
  let removedMetadata = false;
  const runner = {
    async run(_command: string, args: string[]) {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' };
      if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
      if (args[0] === 'update-ref') return { code: 1, stdout: '', stderr: 'cannot lock ref: is at bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb but expected aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => removeWorkspace({ ...metadata, cleanup: { container: true } }, { confirmed: true }, runner, async () => undefined, async () => { removedMetadata = true; }),
    /git update-ref failed/,
  );
  assert.equal(calls.some((args) => args[0] === 'branch' && args[1] === '-D'), false);
  assert.deepEqual(calls.at(-1), ['update-ref', '--stdin']);
  assert.equal(removedMetadata, false);
});

test('removeWorkspace atomically verifies the captured base OID before deleting the verified branch', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  let removedMetadata = false;
  const branchOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const baseOid = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const runner = {
    async run(_command: string, args: string[], options?: { input?: string }) {
      calls.push({ args, input: options?.input });
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: args.at(-1) === 'refs/heads/main' ? `${baseOid}\n` : `${branchOid}\n`, stderr: '' };
      if (args[0] === 'update-ref') return { code: 1, stdout: '', stderr: 'base changed' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => removeWorkspace({ ...metadata, cleanup: { container: true } }, { confirmed: true }, runner, async () => undefined, async () => { removedMetadata = true; }),
    /git update-ref failed/,
  );
  assert.deepEqual(calls.at(-1), {
    args: ['update-ref', '--stdin'],
    input: `start\nverify refs/heads/main ${baseOid}\ndelete refs/heads/agent-containers/safe ${branchOid}\nprepare\ncommit\n`,
  });
  assert.equal(removedMetadata, false, 'a changed base leaves branch cleanup and state intact');
});

test('removeWorkspace advances expected metadata generations through every checkpoint and final deletion', async () => {
  const generations: Array<string | null | undefined> = [];
  const initial = { ...metadata, cleanup: { container: true } };
  const runner = { async run(_command: string, args: string[]) {
    if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: worktreeListing, stderr: '' };
    if (args[0] === 'show-ref') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  } };
  await removeWorkspace(initial, { confirmed: true }, runner, async (_next, options) => { generations.push(options.expectedGeneration); }, async (options) => { generations.push(options.expectedGeneration); });
  assert.equal(generations.length, 3);
  assert.ok(generations.every((generation) => typeof generation === 'string' && generation.length === 64));
  assert.notEqual(generations[0], generations[1]);
  assert.notEqual(generations[1], generations[2]);
});
