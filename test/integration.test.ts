import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createWorkspace, nodeProcessRunner, PROCESS_OUTPUT_LIMIT } from '../src/workspaces.js';
import { execWorkspace } from '../src/runtime.js';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const dockerAvailable = spawnSync('docker', ['version']).status === 0;
const devcontainerAvailable = spawnSync('devcontainer', ['--version']).status === 0;
const relativeWorktreeSupported = gitAvailable && /--relative-paths/.test(`${spawnSync('git', ['worktree', 'add', '-h'], { encoding: 'utf8' }).stdout}${spawnSync('git', ['worktree', 'add', '-h'], { encoding: 'utf8' }).stderr}`);

test('create produces an isolated worktree without altering source checkout files', { skip: !gitAvailable ? 'Git is unavailable' : !relativeWorktreeSupported ? 'installed Git does not support git worktree add --relative-paths' : false }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agent-containers-git-'));
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: repo }).status, 0);
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'source.txt'), 'original\n');
  git('add', 'source.txt');
  git('commit', '-m', 'initial');

  const metadata = await createWorkspace({ cwd: repo, name: 'isolated', config: { version: 1, workspace: { worktreeRoot: `${repo}-worktrees`, baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, stateDir: `${repo}-state`, runner: nodeProcessRunner });
  await access(metadata.worktree);
  assert.equal(await readFile(join(repo, 'source.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(metadata.worktree, 'source.txt'), 'utf8'), 'original\n');
});

test('nodeProcessRunner forwards inherited terminal output without a shell', async () => {
  const result = await nodeProcessRunner.run(process.execPath, ['-e', 'process.stdout.write("agent-containers-terminal-smoke\\n")'], { stdio: 'inherit' });
  assert.equal(result.code, 0);
});

test('nodeProcessRunner bounds burst capture while retaining terminal Dev Containers JSON', async () => {
  const result = await nodeProcessRunner.run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${PROCESS_OUTPUT_LIMIT * 2})); process.stdout.write('\\n{"containerId":"terminal"}\\n')`]);
  assert.ok(result.stdout.length <= PROCESS_OUTPUT_LIMIT);
  assert.match(result.stdout, /\{"containerId":"terminal"\}\n$/);
});

test('production execWorkspace lifecycle exposes the Git common directory inside a linked worktree', {
  skip: !dockerAvailable ? 'Docker is unavailable' : !devcontainerAvailable ? 'Dev Containers CLI is unavailable' : !relativeWorktreeSupported ? 'installed Git does not support git worktree add --relative-paths' : false,
}, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agent-containers-devcontainer-'));
  const worktree = `${repo}-worktree`;
  const stateDir = `${repo}-state`;
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: repo }).status, 0);
  let containerId: string | undefined;
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(join(repo, 'source.txt'), 'source\n');
    await writeFile(join(repo, '.devcontainer.json'), JSON.stringify({ image: 'mcr.microsoft.com/devcontainers/base:ubuntu' }));
    git('add', '.');
    git('commit', '-m', 'initial');
    git('worktree', 'add', '--relative-paths', '-b', 'agent-containers/integration', worktree, 'main');
    await execWorkspace({ version: 1, name: 'integration', repoRoot: repo, worktree, branch: 'agent-containers/integration', baseBranch: 'main', devcontainerPath: '.devcontainer.json', createdAt: new Date().toISOString() }, ['sh', '-lc', 'git rev-parse --git-common-dir > .agent-containers-git-common-dir'], nodeProcessRunner, async (next) => { containerId = next.containerId; });
    assert.match(await readFile(join(worktree, '.agent-containers-git-common-dir'), 'utf8'), /worktrees|\.git/);
  } finally {
    if (containerId) spawnSync('docker', ['rm', '-f', containerId]);
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo });
    await rm(repo, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
