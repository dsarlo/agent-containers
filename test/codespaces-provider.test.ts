import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { GhCodespacesProvider, type CodespacesProviderProcess, type CodespacesCreatePayload, type CodespacesResource } from '../src/codespaces.js';

function resourceFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '9876543210',
    display_name: 'bookish-space-parakeet',
    name: 'bookish-space-parakeet',
    environment_id: '8f1c1f0e-8e5f-4c2e-9b0a-1234567890ab',
    owner: { id: 1, login: 'octo' },
    repository: { id: 42, name: 'agent-containers', owner: { id: 1, login: 'octo' } },
    billable_owner: { id: 1, login: 'octo' },
    machine: { name: 'basicLinux32gb' },
    location: 'EastUs',
    created_at: '2026-09-02T12:00:00Z',
    state: 'Running',
    git_status: { ref: 'main' },
    devcontainer_path: '.devcontainer/devcontainer.json',
    idle_timeout_minutes: 30,
    retention_period_minutes: 10080,
    ...overrides,
  };
}

const validPayload: CodespacesCreatePayload = {
  repositoryId: '42',
  ref: 'refs/heads/main',
  devcontainerPath: '.devcontainer/devcontainer.json',
  machine: 'basicLinux32gb',
  idleTimeoutMinutes: 30,
  retentionPeriodMinutes: 10080,
  geo: 'EastUs',
};

function respondingProcess(onArgs: (args: string[]) => void, responseFor: ((args: string[]) => unknown) | Record<string, unknown>): CodespacesProviderProcess {
  return {
    async run(command, args) {
      assert.equal(command, 'gh');
      onArgs(args);
      const body = typeof responseFor === 'function' ? responseFor(args) : responseFor;
      return typeof body === 'string' ? { code: 0, stdout: body, stderr: '' } : { code: 0, stdout: JSON.stringify(body), stderr: '' };
    },
  };
}

test('committed Codespaces devcontainer includes the official SSHD feature required by gh codespace ssh', async () => {
  const config = JSON.parse(await readFile(resolve('.devcontainer/devcontainer.json'), 'utf8')) as { features?: Record<string, { version?: unknown }> };
  assert.equal(config.features?.['ghcr.io/devcontainers/features/sshd:1']?.version, 'latest');
});

test('provider create dispatches the documented POST argv with explicit body fields and no shell', async () => {
  const calls: string[][] = [];
  const provider = new GhCodespacesProvider(respondingProcess((args) => calls.push(args), resourceFixture()));
  const resource = await provider.create(validPayload);
  assert.equal(resource.id, '9876543210');
  assert.equal(resource.state, 'Running');
  assert.deepEqual(calls, [[
    'api', '--method', 'POST', '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-F', 'repository_id=42',
    '-f', 'ref=refs/heads/main',
    '-f', 'devcontainer_path=.devcontainer/devcontainer.json',
    '-f', 'machine=basicLinux32gb',
    '-F', 'idle_timeout_minutes=30',
    '-F', 'retention_period_minutes=10080',
    '-f', 'geo=EastUs',
    '/user/codespaces',
  ]]);
});

test('provider create includes display_name and enforced policy fields only when supplied', async () => {
  const calls: string[][] = [];
  const provider = new GhCodespacesProvider(respondingProcess((args) => calls.push(args), resourceFixture()));
  await provider.create({ ...validPayload, geo: undefined, displayName: 'agent-containers/issue-9-shell' });
  assert.deepEqual(calls, [[
    'api', '--method', 'POST', '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-F', 'repository_id=42',
    '-f', 'ref=refs/heads/main',
    '-f', 'devcontainer_path=.devcontainer/devcontainer.json',
    '-f', 'machine=basicLinux32gb',
    '-F', 'idle_timeout_minutes=30',
    '-F', 'retention_period_minutes=10080',
    '-f', 'display_name=agent-containers/issue-9-shell',
    '/user/codespaces',
  ]]);
});

test('provider create accepts a documented complete identity when operational response fields are null', async () => {
  const provider = new GhCodespacesProvider(respondingProcess(
    () => undefined,
    resourceFixture({ display_name: null, environment_id: null, machine: null, devcontainer_path: null, idle_timeout_minutes: null }),
  ));
  const resource = await provider.create(validPayload);
  assert.equal(resource.id, '9876543210');
  assert.equal(resource.environmentId, null);
  assert.equal(resource.machineName, null);
  assert.equal(resource.devcontainerPath, null);
  assert.equal(resource.idleTimeoutMinutes, null);
});

test('provider create accepts a provisional receipt only by reading back the exact returned Codespace name', async () => {
  const calls: string[][] = [];
  let readbacks = 0;
  let sleeps = 0;
  const provider = new GhCodespacesProvider(respondingProcess((args) => calls.push(args), (args) => {
    if (args.at(-1) === '/user/codespaces') return { id: '9876543210', name: 'bookish-space-parakeet', state: 'Provisioning' };
    if (args.at(-1) === '/user/codespaces/bookish-space-parakeet' && readbacks++ === 0) return { id: '9876543210', name: 'bookish-space-parakeet' };
    if (args.at(-1) === '/user/codespaces/bookish-space-parakeet') return resourceFixture();
    throw new Error(`unexpected provider call: ${JSON.stringify(args)}`);
  }), async () => { sleeps += 1; });
  const resource = await provider.create(validPayload);
  assert.equal(resource.id, '9876543210');
  assert.equal(resource.name, 'bookish-space-parakeet');
  assert.equal(sleeps, 1);
  assert.deepEqual(calls.map((args) => args.at(-1)), ['/user/codespaces', '/user/codespaces/bookish-space-parakeet', '/user/codespaces/bookish-space-parakeet']);
});

test('provider create bounds and aborts a hung provisional exact readback', async () => {
  let readbackSignal: AbortSignal | undefined;
  const provider = new GhCodespacesProvider({
    async run(_command, args, options) {
      if (args.at(-1) === '/user/codespaces') return { code: 0, stdout: JSON.stringify({ id: '9876543210', name: 'bookish-space-parakeet', state: 'Provisioning' }), stderr: '' };
      if (args.at(-1) === '/user/codespaces/bookish-space-parakeet') {
        readbackSignal = options?.signal;
        return await new Promise<never>(() => {});
      }
      throw new Error(`unexpected provider call: ${JSON.stringify(args)}`);
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(() => Promise.race([
      provider.create(validPayload, { timeoutMs: 20 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test guard elapsed')), 200); }),
    ]), /readback exceeded its bounded deadline/);
  } finally {
    if (timer) clearTimeout(timer);
  }
  assert.equal(readbackSignal?.aborted, true);
});

test('provider create rejects truncated or incomplete responses without adopting a hint', async () => {
  const provider = new GhCodespacesProvider(respondingProcess(
    () => undefined,
    () => JSON.stringify(resourceFixture()).slice(0, 40),
  ));
  await assert.rejects(() => provider.create(validPayload), /truncated or invalid JSON/);
  const incomplete = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ state: undefined })));
  await assert.rejects(() => incomplete.create(validPayload), /safe Codespaces receipt/);
});

test('provider GET readback returns the complete identity and refuses a name mismatch', async () => {
  const provider = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture()));
  const readback = await provider.get('bookish-space-parakeet');
  assert.equal(readback.name, 'bookish-space-parakeet');
  assert.equal(readback.owner.login, 'octo');
  assert.equal(readback.geo, null);
  assert.equal(readback.location, 'EastUs');

  const wrong = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ name: 'other' })));
  await assert.rejects(() => wrong.get('bookish-space-parakeet'), /requested Codespaces name/);

  const missing = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ devcontainer_path: undefined })));
  await assert.rejects(() => missing.get('bookish-space-parakeet'), /complete Codespaces identity/);
});

test('provider GET readback never accepts new provider fields as identity without validation', async () => {
  const hostile = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ git_status: undefined })));
  await assert.rejects(() => hostile.get('bookish-space-parakeet'), /complete Codespaces identity/);
});

test('provider creation logs use a bounded gh codespace logs argv and never exceed its bound', async () => {
  const calls: string[][] = [];
  const provider = new GhCodespacesProvider({
    async run(command, args) {
      calls.push([command, ...args]);
      return { code: 0, stdout: 'definitely not a running task command', stderr: '' };
    },
  });
  assert.equal(await provider.creationLogs('bookish-space-parakeet', 100), 'definitely not a running task command');
  assert.deepEqual(calls, [['gh', 'codespace', 'logs', '-c', 'bookish-space-parakeet', '-l', '100']]);
});

test('provider creation logs fail closed on nonzero exit and redact credential-shaped output', async () => {
  const calls: string[][] = [];
  const provider = new GhCodespacesProvider({
    async run(command, args) {
      calls.push([command, ...args]);
      return { code: 1, stdout: '', stderr: 'gh codespace logs failed: ghp_abcdefghijklmnopqrstuvwxyz123456 Authorization: Bearer sentinel-token-value https://api.example.test/leak?token=abc' };
    },
  });
  await assert.rejects(() => provider.creationLogs('bookish-space-parakeet', 100), (error: Error) => !error.message.includes('ghp_') && !error.message.includes('sentinel-token-value') && !error.message.includes('https://'));
  assert.deepEqual(calls, [['gh', 'codespace', 'logs', '-c', 'bookish-space-parakeet', '-l', '100']]);
});

test('provider marks helper writes as lifecycle work while preserving read-only SSH probes', async () => {
  const kinds: Array<'lifecycle' | 'readonly-probe' | undefined> = [];
  const provider = new GhCodespacesProvider({
    async run(_command, _args, options) {
      kinds.push(options?.kind);
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  await provider.remoteSshProbe('bookish-space-parakeet', ['uname', '-m']);
  await provider.remoteCommand('bookish-space-parakeet', ['mkdir', '-p', '/workspaces/.agent-containers/test/bin']);
  assert.deepEqual(kinds, ['readonly-probe', 'lifecycle']);
});

test('provider SSH probe dispatches a fixed package-owned command through gh codespace ssh', async () => {
  const calls: string[][] = [];
  const provider = new GhCodespacesProvider({
    async run(command, args) {
      calls.push([command, ...args]);
      return { code: 0, stdout: '/workspaces/agent-containers\n0123456789012345678901234567890123456789\ngit@github.com:octo/agent-containers.git\n', stderr: '' };
    },
  });
  const output = await provider.remoteSshProbe('bookish-space-parakeet', ['git', '-C', '/workspaces/agent-containers', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  assert.equal(output.startsWith('/workspaces/agent-containers'), true);
  assert.deepEqual(calls, [['gh', 'codespace', 'ssh', '-c', 'bookish-space-parakeet', '--', 'git', '-C', '/workspaces/agent-containers', 'rev-parse', '--show-toplevel']]);
});

test('provider SSH probe applies a bounded deadline and rejects on timeout without a shell', async () => {
  const provider = new GhCodespacesProvider({
    async run(_command, _args, options) {
      assert.ok(options !== undefined, 'SSH probe must be bounded by the runner deadline');
      throw new Error('SSH transport timed out.');
    },
  });
  await assert.rejects(() => provider.remoteSshProbe('bookish-space-parakeet', ['true'], { timeoutMs: 5000 }));
});

test('provider SSH probe rejects when the exact recorded Codespaces name is unsafe', async () => {
  const provider = new GhCodespacesProvider({ async run() { return { code: 0, stdout: '', stderr: '' }; } });
  await assert.rejects(() => provider.remoteSshProbe('sk-' + 'x'.repeat(24), ['true']), (error: Error) => !error.message.includes('x'.repeat(24)));
});

test('provider repository record reads the immutable repository database identity', async () => {
  const calls: string[][] = [];
  const provider = new GhCodespacesProvider(respondingProcess((args) => calls.push(args), { id: 42, name: 'agent-containers', full_name: 'octo/agent-containers', owner: { id: 1, login: 'octo' } }));
  const record = await provider.repositoryRecord('octo/agent-containers');
  assert.deepEqual(record, { id: '42', owner: 'octo', name: 'agent-containers' });
  assert.deepEqual(calls, [['api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/repos/octo/agent-containers']]);
});

test('provider rejects secret-shaped values in every documented mapped resource field before they can be recorded', async () => {
  const hidden = 'sk-' + 'x'.repeat(24);
  const hostile = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ display_name: hidden })));
  await assert.rejects(() => hostile.get('bookish-space-parakeet'), (error: Error) => !error.message.includes(hidden));
  const machine = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ machine: { name: hidden } })));
  await assert.rejects(() => machine.get('bookish-space-parakeet'), (error: Error) => !error.message.includes(hidden));
  const billableOwner = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ billable_owner: { id: 1, login: hidden } })));
  await assert.rejects(() => billableOwner.get('bookish-space-parakeet'), (error: Error) => !error.message.includes(hidden));
});

test('provider resource carries lossless identity fields for fail-closed ownership', async () => {
  const provider = new GhCodespacesProvider(respondingProcess(() => undefined, resourceFixture({ id: '9007199254740993' })));
  const resource: CodespacesResource = await provider.get('bookish-space-parakeet');
  assert.equal(resource.id, '9007199254740993', 'numeric-id strings must be handled losslessly');
});

test('provider lifecycle operations use exact documented argv and port observation is read-only', async () => {
  const calls: string[][] = [];
  const provider = new GhCodespacesProvider({
    async run(_command, args) {
      calls.push(args);
      if (args.at(-1)?.endsWith('/ports')) return { code: 0, stdout: JSON.stringify([{ port: 3000, visibility: 'private' }]), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  await provider.setState('bookish-space-parakeet', 'Shutdown');
  await provider.setState('bookish-space-parakeet', 'Running');
  await provider.delete('bookish-space-parakeet');
  assert.deepEqual(await provider.ports('bookish-space-parakeet'), [{ port: 3000, visibility: 'private' }]);
  assert.deepEqual(calls, [
    ['api', '--method', 'PATCH', '-H', 'X-GitHub-Api-Version: 2022-11-28', '-f', 'state=Shutdown', '/user/codespaces/bookish-space-parakeet'],
    ['api', '--method', 'PATCH', '-H', 'X-GitHub-Api-Version: 2022-11-28', '-f', 'state=Running', '/user/codespaces/bookish-space-parakeet'],
    ['api', '--method', 'DELETE', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/user/codespaces/bookish-space-parakeet'],
    ['api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/user/codespaces/bookish-space-parakeet/ports'],
  ]);
});
