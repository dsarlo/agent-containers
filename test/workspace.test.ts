import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateWorkspaceName } from '../src/names.js';
import { createWorkspace, type ProcessRunner } from '../src/workspaces.js';
import type { AgentContainersConfig } from '../src/types.js';

test('CI captures git worktree help even though Git exits 129', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /worktree_help="\$\(git worktree add -h 2>&1 \|\| true\)"/);
  assert.match(workflow, /grep -Eq -- '([^']*relative-paths[^']*)' <<<"\$\{worktree_help\}"/);
});

test('validateWorkspaceName rejects unsafe names', () => {
  assert.equal(validateWorkspaceName('feature-123'), 'feature-123');
  for (const name of ['', '../escape', 'has space', 'two//slashes', '.hidden', 'UPPER', 'two--hyphens', 'trailing-']) {
    assert.throws(() => validateWorkspaceName(name), /Workspace name/);
  }
});

test('createWorkspace only accepts and records a verified canonical local base ref', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-base-ref-'));
  const config: AgentContainersConfig = { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} };
  for (const base of ['origin/main', 'refs/tags/v1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(_command, args) {
        calls.push(args);
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${directory}\n`, stderr: '' };
        if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' ? 0 : 1, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '--[no-]relative-paths\n' };
      },
    };
    await assert.rejects(() => createWorkspace({ cwd: directory, name: 'safe', config, stateDir: join(directory, `state-${base.replaceAll('/', '-')}`), baseBranch: base, runner }), /local branch|refs\/heads/);
    assert.equal(calls.some((args) => args[0] === 'worktree' && args[1] === 'add'), false);
  }

  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${directory}\n`, stderr: '' };
      if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' ? 0 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '--[no-]relative-paths\n' };
    },
  };
  const created = await createWorkspace({ cwd: directory, name: 'local', config, stateDir: join(directory, 'state-local'), runner });
  assert.equal((created as unknown as { baseRef?: string }).baseRef, 'refs/heads/main');
  assert.deepEqual(calls.at(-1), ['worktree', 'add', '--relative-paths', '-b', 'agent-containers/local', join(directory, 'worktrees', 'local'), 'refs/heads/main']);
});


test('createWorkspace uses relative Git directory pointers when Git supports them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-workspace-'));
  const calls: Array<{ command: string; args: string[]; cwd?: string; stdio?: string }> = [];
  const runner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ command, args, ...options });
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${directory}\n`, stderr: '' };
      if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' ? 0 : 1, stdout: '', stderr: '' };
      if (args.at(-1) === '-h') return { code: 129, stdout: '', stderr: '--[no-]relative-paths\n' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await createWorkspace({ cwd: directory, name: 'relative', config: { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, stateDir: join(directory, 'state'), runner });
  assert.deepEqual(calls.at(-1), { command: 'git', args: ['worktree', 'add', '--relative-paths', '-b', 'agent-containers/relative', join(directory, 'worktrees', 'relative'), 'refs/heads/main'], cwd: directory });
});

test('createWorkspace refuses to create a linked worktree when Git lacks relative Git directory pointers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-workspace-'));
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${directory}\n`, stderr: '' };
      if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' ? 0 : 1, stdout: '', stderr: '' };
      if (args.at(-1) === '-h') return { code: 129, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => createWorkspace({ cwd: directory, name: 'unsupported', config: { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, stateDir: join(directory, 'state'), runner }),
    /--relative-paths/,
  );
  assert.equal(calls.some((args) => args[0] === 'worktree' && args[1] === 'add' && args[2] !== '-h'), false);
});

test('createWorkspace reports exact branch and worktree recovery details after an interrupted worktree add without deleting either', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-add-recovery-'));
  const worktree = join(directory, 'worktrees', 'partial');
  const calls: string[][] = [];
  let addAttempted = false;
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${directory}\n`, stderr: '' };
      if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' || (addAttempted && args.at(-1) === 'refs/heads/agent-containers/partial') ? 0 : 1, stdout: '', stderr: '' };
      if (args.at(-1) === '-h') return { code: 129, stdout: '', stderr: '--[no-]relative-paths\n' };
      if (args[0] === 'worktree' && args[1] === 'add') { addAttempted = true; throw Object.assign(new Error('interrupted'), { name: 'AbortError' }); }
      if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stdout: `worktree ${worktree}\nbranch refs/heads/agent-containers/partial\n`, stderr: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  };
  await assert.rejects(
    () => createWorkspace({ cwd: directory, name: 'partial', config: { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, stateDir: join(directory, 'state'), runner }),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /interrupted.*left it intact.*git worktree list/s);
      assert.equal(message.includes('refs/heads/agent-containers/partial is present'), true);
      return true;
    },
  );
  assert.equal(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'), false);
  assert.equal(calls.some((args) => args[0] === 'branch' && args[1] === '-D'), false);
});


test('createWorkspace preserves its worktree and branch if metadata persistence fails rather than force-deleting user data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-workspace-'));
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(_command, args) { calls.push(args); if (args[0] === 'rev-parse') return { code: 0, stdout: `${directory}\n`, stderr: '' }; if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' ? 0 : 1, stdout: '', stderr: '' }; if (args.at(-1) === '-h') return { code: 129, stdout: '', stderr: '--[no-]relative-paths\n' }; return { code: 0, stdout: '', stderr: '' }; } };
  await assert.rejects(() => createWorkspace({ cwd: directory, name: 'rollback', config: { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, stateDir: join(directory, 'state'), runner, save: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'), false);
  assert.equal(calls.some((args) => args[0] === 'branch' && args[1] === '-D'), false);
});

test('createWorkspace constructs git commands through the injected runner and writes metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-workspace-'));
  const stateDir = join(directory, 'state');
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${directory}\n`, stderr: '' };
      if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' ? 0 : 1, stdout: '', stderr: '' };
      if (args.at(-1) === '-h') return { code: 129, stdout: '', stderr: '--[no-]relative-paths\n' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  const metadata = await createWorkspace({
    cwd: directory,
    name: 'feature-123',
    config: { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} },
    stateDir,
    runner,
  });

  assert.equal(metadata.branch, 'agent-containers/feature-123');
  assert.deepEqual(calls.at(-1), { command: 'git', args: ['worktree', 'add', '--relative-paths', '-b', 'agent-containers/feature-123', join(directory, 'worktrees', 'feature-123'), 'refs/heads/main'] });
  assert.equal(JSON.parse(await readFile(join(stateDir, 'workspaces', 'feature-123.json'), 'utf8')).name, 'feature-123');
});

test('createWorkspace rejects an existing Agent Containers workspace before invoking git worktree add', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-workspace-'));
  const stateDir = join(directory, 'state');
  await writeFile(join(directory, 'placeholder'), 'source checkout stays untouched');
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(_command, args) { calls.push(args); if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/main' ? 0 : 1, stdout: '', stderr: '' }; if (args.at(-1) === '-h') return { code: 129, stdout: '', stderr: '--[no-]relative-paths\n' }; return { code: 0, stdout: `${directory}\n`, stderr: '' }; } };
  const config: AgentContainersConfig = { version: 1, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} };
  await createWorkspace({ cwd: directory, name: 'same', config, stateDir, runner });
  await assert.rejects(() => createWorkspace({ cwd: directory, name: 'same', config, stateDir, runner }), /already exists/);
  assert.equal(calls.filter((args) => args[0] === 'worktree' && args[1] === 'add' && args.at(-1) !== '-h').length, 1);
});
