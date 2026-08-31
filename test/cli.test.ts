import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { exitCodeForError, runCli } from '../src/cli.js';

test('CLI parses destructive confirmation options strictly', async () => {
  const messages: string[] = [];
  assert.equal(await runCli(['remove', 'safe'], process.cwd(), (message) => messages.push(message)), 2);
  assert.match(messages.at(-1) ?? '', /--yes/);
  assert.equal(await runCli(['remove', 'safe', '--yes', '--unexpected'], process.cwd(), () => undefined), 2);
  assert.equal(await runCli(['remove', 'safe', '--skip-container-cleanup'], process.cwd(), () => undefined), 2);
});

test('CLI preserves valid remote process exit statuses', () => {
  assert.equal(exitCodeForError({ exitCode: 42 }), 42);
  assert.equal(exitCodeForError({ exitCode: 0 }), undefined);
  assert.equal(exitCodeForError({ exitCode: 256 }), undefined);
});

test('CLI help and errors use the public Agent Containers command identity', async () => {
  const messages: string[] = [];
  assert.equal(await runCli(['unknown-command'], process.cwd(), (message) => messages.push(message)), 2);
  assert.match(messages[0], /Usage: agent-containers /);
});

test('init and implicit validation resolve the repository root from a subdirectory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-root-'));
  const nested = join(root, 'nested', 'deeper');
  await mkdir(nested, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  const messages: string[] = [];
  assert.equal(await runCli(['init'], nested, (message) => messages.push(message)), 0);
  assert.match(messages[0], new RegExp(`Wrote ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.agent-containers\\.yml`));
  assert.match(await readFile(join(root, '.agent-containers.yml'), 'utf8'), /version: 1/);
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\n');
  assert.equal(await runCli(['validate'], nested, () => undefined), 0);
});
