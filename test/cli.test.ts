import assert from 'node:assert/strict';
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
