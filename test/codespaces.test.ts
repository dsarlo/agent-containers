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

test('provider reads only the documented repository machine inventory and validates its response', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const provider = new GhCodespacesProvider({ async run(command, args) {
    calls.push({ command, args });
    return { code: 0, stdout: '{"total_count":1,"machines":[{"name":"basicLinux32gb","display_name":"Basic","operating_system":"linux","storage_in_bytes":1,"memory_in_bytes":1,"cpus":1,"prebuild_availability":null}]}', stderr: '' };
  } });
  assert.equal((await provider.machines('owner/repo', 'refs/heads/main', 'us-east')).machines[0]?.name, 'basicLinux32gb');
  assert.deepEqual(calls, [{ command: 'gh', args: ['api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/repos/owner/repo/codespaces/machines?ref=refs%2Fheads%2Fmain&location=us-east'] }]);
  const malformed = new GhCodespacesProvider({ async run() { return { code: 0, stdout: '{"total_count":1,"machines":[]}', stderr: '' }; } });
  await assert.rejects(() => malformed.machines('owner/repo', 'refs/heads/main'), /incomplete/);
});

test('provider strictly parses documented defaults and complete machine inventory fields', async () => {
  const provider = new GhCodespacesProvider({ async run(_command, args) {
    if (args.at(-1)?.includes('/codespaces/new')) return { code: 0, stdout: JSON.stringify({ billable_owner: { id: 1, login: 'octo' }, defaults: { location: 'East US', devcontainer_path: '.devcontainer/devcontainer.json' } }), stderr: '' };
    return { code: 0, stdout: JSON.stringify({ total_count: 1, machines: [{ name: 'basicLinux32gb', display_name: 'Basic Linux', operating_system: 'linux', storage_in_bytes: 1, memory_in_bytes: 2, cpus: 4, prebuild_availability: 'ready' }] }), stderr: '' };
  } });
  assert.deepEqual(await provider.defaults('owner/repo', 'refs/heads/main'), { billableOwner: { id: '1', login: 'octo' }, location: 'East US', devcontainerPath: '.devcontainer/devcontainer.json' });
  assert.deepEqual((await provider.machines('owner/repo', 'refs/heads/main')).machines[0], { name: 'basicLinux32gb', displayName: 'Basic Linux', operatingSystem: 'linux', storageInBytes: 1, memoryInBytes: 2, cpus: 4, prebuildAvailability: 'ready' });
  const malformed = new GhCodespacesProvider({ async run() { return { code: 0, stdout: '{"total_count":1,"machines":[{"name":"basic"}]}', stderr: '' }; } });
  await assert.rejects(() => malformed.machines('owner/repo', 'refs/heads/main'), /invalid machine/);
});

test('provider rejects incomplete identity and never adopts by name', async () => {
  const provider = new GhCodespacesProvider({ async run() { return { code: 0, stdout: JSON.stringify({ name: 'same-name' }), stderr: '' }; } });
  await assert.rejects(() => provider.get('same-name'), /complete Codespace identity/);
});

test('provider requires the observed Codespace name to equal the exact requested name', async () => {
  const provider = new GhCodespacesProvider({ async run() { return { code: 0, stdout: JSON.stringify({ id: '42', name: 'other', environment_id: 'env', state: 'Available' }), stderr: '' }; } });
  await assert.rejects(() => provider.get('requested'), /requested Codespace name/);
});

test('provider diagnostics redact URLs, query strings, and credential-shaped values', async () => {
  const provider = new GhCodespacesProvider({ async run() { return { code: 1, stdout: '', stderr: 'GET https://api.example.test/path?token=abc Authorization: Bearer secret-value ghp_abcdefghijklmnopqrstuvwxyz123456' }; } });
  await assert.rejects(() => provider.actor(), (error: Error) => !error.message.includes('https://') && !error.message.includes('secret-value') && !error.message.includes('ghp_'));
});

test('remote execution requests reject shell-shaped unsafe inputs before transport', () => {
  assert.throws(() => assertSafeExecuteRequest({ commandId: 'x', argv: ['echo', 'x\u0000y'], mode: 'pipe', stdin: 'closed' }), /NUL/);
  assert.throws(() => assertSafeExecuteRequest({ commandId: 'x', argv: ['echo'], cwd: '../outside', mode: 'pipe', stdin: 'closed' }), /repository-relative/);
});
