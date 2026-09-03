import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import test from 'node:test';
import { inventoryWorkspaces } from '../src/inventory.js';
import { recordManualRecovery, saveMetadata } from '../src/state.js';

const id = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

function metadata(root: string, name = 'safe') {
  return { version: 1 as const, name, repoRoot: root, worktree: join(root, 'worktrees', name), branch: `agent-containers/${name}`, baseRef: 'refs/heads/main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z', containerId: id };
}

test('inventory reports dirty worktrees, manual recovery, and only read-only probe calls', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-inventory-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-inventory-repo-'));
  const entry = metadata(root);
  await mkdir(entry.worktree, { recursive: true });
  await saveMetadata(stateDir, entry, { expectedGeneration: null });
  await recordManualRecovery(stateDir, entry.name, { reason: 'operation-may-be-active', containerIds: [id], worktree: entry.worktree });
  const calls: string[] = [];
  const runner = { async run(command: string, args: string[]) { calls.push([command, ...args].join(' ')); if (command === 'git' && args[1] === 'status') return { code: 0, stdout: '?? report.txt\n', stderr: '' }; if (command === 'docker' && args[0] === 'ps') return { code: 0, stdout: `${id}\n`, stderr: '' }; if (command === 'docker' && args[0] === 'inspect') return { code: 0, stdout: `${id}\n${entry.worktree}\n`, stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
  const [observed] = await inventoryWorkspaces(stateDir, runner, { probe: true });
  assert.equal(observed.worktree.state, 'dirty');
  assert.equal(observed.recovery, 'required');
  assert.equal(observed.container.state, 'present');
  assert.ok(calls.every((call) => !/\b(rm|start|stop|remove)\b/.test(call)));
});

test('inventory marks missing worktrees, Docker absence, and label mismatch without adoption', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-inventory-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-inventory-repo-'));
  const entry = metadata(root, 'missing');
  await saveMetadata(stateDir, entry, { expectedGeneration: null });
  const runner = { async run(command: string, args: string[]) { if (command === 'docker' && args[0] === 'ps') return { code: 0, stdout: `${id}\n`, stderr: '' }; if (command === 'docker') return { code: 0, stdout: `${id}\n${join(root, 'other')}\n`, stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
  const [observed] = await inventoryWorkspaces(stateDir, runner, { probe: true });
  assert.equal(observed.worktree.state, 'missing');
  assert.equal(observed.container.state, 'ambiguous');
});

test('inventory never exposes container inspect payloads', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-inventory-'));
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-inventory-repo-'));
  const entry = metadata(root);
  await mkdir(entry.worktree, { recursive: true });
  await saveMetadata(stateDir, entry, { expectedGeneration: null });
  const secret = 'INVENTORY_SECRET_SENTINEL';
  const runner = { async run(command: string) { return command === 'docker' ? { code: 1, stdout: secret, stderr: secret } : { code: 0, stdout: '', stderr: '' }; } };
  const result = JSON.stringify(await inventoryWorkspaces(stateDir, runner, { probe: true }));
  assert.doesNotMatch(result, new RegExp(secret));
});
