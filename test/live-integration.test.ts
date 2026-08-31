import assert from 'node:assert/strict';
import test from 'node:test';
import { isLiveIntegrationEnabled } from '../src/live-integration.js';

test('live integration requires an explicit opt-in even when Docker is available', () => {
  assert.equal(isLiveIntegrationEnabled({}), false);
  assert.equal(isLiveIntegrationEnabled({ AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION: '0' }), false);
  assert.equal(isLiveIntegrationEnabled({ AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION: '1' }), true);
});
