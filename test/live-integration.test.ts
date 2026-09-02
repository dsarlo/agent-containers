import assert from 'node:assert/strict';
import test from 'node:test';
import { isLiveIntegrationEnabled, probeLiveIntegrationPrerequisites } from '../src/live-integration.js';

test('live integration requires an explicit opt-in even when Docker is available', () => {
  assert.equal(isLiveIntegrationEnabled({}), false);
  assert.equal(isLiveIntegrationEnabled({ AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION: '0' }), false);
  assert.equal(isLiveIntegrationEnabled({ AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION: '1' }), true);
});

test('live integration does not invoke Docker or Dev Containers probes without opt-in', () => {
  const probes: string[] = [];
  const result = probeLiveIntegrationPrerequisites({}, (command) => {
    probes.push(command);
    return { status: 0 };
  });
  assert.deepEqual(probes, ['git', 'git']);
  assert.deepEqual(result, { gitAvailable: true, dockerAvailable: false, devcontainerAvailable: false, relativeWorktreeSupported: false });
});

test('Windows live diagnostics use the same public Dev Containers Node argv as lifecycle commands', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const probe = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { status: 0 };
  };
  const resolver = () => ({ command: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: ['C:\\Users\\agent\\AppData\\Roaming\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js'] });

  (probeLiveIntegrationPrerequisites as unknown as (environment: NodeJS.ProcessEnv, probe: (command: string, args: string[]) => { status: number }, dependencies: { resolveDevcontainerInvocation: typeof resolver }) => unknown)(
    { AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION: '1' },
    probe,
    { resolveDevcontainerInvocation: resolver },
  );

  assert.deepEqual(calls.at(-1), {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\agent\\AppData\\Roaming\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js', '--version'],
  });
});
