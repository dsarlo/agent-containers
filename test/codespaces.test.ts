import assert from 'node:assert/strict';
import test from 'node:test';
import { GhCodespacesProvider, assertSafeExecuteRequest, type CodespacesProviderProcess } from '../src/codespaces.js';

test('Codespaces provider uses documented gh api argument vectors and never a shell', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const process: CodespacesProviderProcess = { async run(command, args) {
    calls.push({ command, args });
    return { code: 0, stdout: JSON.stringify({ id: 42, login: 'octo' }), stderr: '' };
  } };
  const provider = new GhCodespacesProvider(process);
  await provider.actor();
  assert.deepEqual(calls, [{ command: 'gh', args: ['api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/user'] }]);
});

test('provider rejects incomplete identity and never adopts by name', async () => {
  const provider = new GhCodespacesProvider({ async run() { return { code: 0, stdout: JSON.stringify({ name: 'same-name' }), stderr: '' }; } });
  await assert.rejects(() => provider.get('same-name'), /complete Codespace identity/);
});

test('remote execution requests reject shell-shaped unsafe inputs before transport', () => {
  assert.throws(() => assertSafeExecuteRequest({ commandId: 'x', argv: ['echo', 'x\u0000y'], mode: 'pipe', stdin: 'closed' }), /NUL/);
  assert.throws(() => assertSafeExecuteRequest({ commandId: 'x', argv: ['echo'], cwd: '../outside', mode: 'pipe', stdin: 'closed' }), /repository-relative/);
});
