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
