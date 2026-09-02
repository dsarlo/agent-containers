import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capacityReport, categorizeCreateIntent, categorizeWorkspace, withGlobalCapacityLock, type CapacityCountedWorkspace, type CapacityPolicy } from '../src/codespaces-capacity.js';
import type { CodespacesWorkspaceMetadata } from '../src/state.js';

const policy: CapacityPolicy = { maxCreating: 1, maxRunning: 2, maxTotal: 4 };

function counted(...categories: CapacityCountedWorkspace[]): CapacityCountedWorkspace[] { return categories; }
const creating = (name: string): CapacityCountedWorkspace => ({ name, category: 'creating' });
const running = (name: string): CapacityCountedWorkspace => ({ name, category: 'running' });
const stopped = (name: string): CapacityCountedWorkspace => ({ name, category: 'stopped' });
const uncertain = (name: string): CapacityCountedWorkspace => ({ name, category: 'uncertain' });

function workspaceFixture(normalized: string): CodespacesWorkspaceMetadata {
  return {
    version: 2, backend: 'codespaces', name: 'issue-9', workspaceId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789', effectiveBranch: 'agent-containers/issue-9', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
    remote: { codespaceId: '9876543210', name: 'bookish-space-parakeet', environmentId: 'env-id', ownerId: '1', ownerLogin: 'octo', billableOwnerId: '1', machine: 'basicLinux32gb', geo: 'EastUs', createdAt: '2026-09-02T12:00:00Z' },
    lifecycle: { desired: 'ready', normalized, providerRawState: 'Running', lastObservedAt: '2026-09-02T12:00:00.000Z', activeOperation: null },
    recovery: null, cleanup: { remoteStopped: false, remoteDeleted: false, tombstoneWritten: false },
  };
}

test('capacity report is fully conservative when empty and allows one conservative create', () => {
  assert.deepEqual(capacityReport(counted(), policy), {
    allowed: true, blockers: [],
    slots: { maxCreating: 1, maxRunning: 2, maxTotal: 4, creating: 0, running: 0, total: 0 },
    existing: [],
  });
});

test('capacity blocks a second concurrent create beyond maxCreating', () => {
  const report = capacityReport(counted(creating('a'), running('b')), policy);
  assert.equal(report.allowed, false);
  assert.match(report.blockers.join(' '), /creating 1\/1/);
});

test('capacity blocks when total recorded Codespaces reach maxTotal', () => {
  const report = capacityReport(counted(stopped('a'), stopped('b'), uncertain('c'), running('d')), policy);
  assert.equal(report.allowed, false);
  assert.match(report.blockers.join(' '), /total recorded Codespaces 4\/4/);
});

test('capacity reports running and creating slots separately with the conservative limits', () => {
  const report = capacityReport(counted(creating('c'), running('r1'), running('r2')), policy);
  assert.deepEqual(report.slots, { maxCreating: 1, maxRunning: 2, maxTotal: 4, creating: 1, running: 2, total: 3 });
  assert.equal(report.allowed, false, 'creating slot is exhausted');
});

test('mixed uncertain and stopped workspaces consume conservative total slots', () => {
  const report = capacityReport(counted(stopped('a'), uncertain('b'), running('c')), policy);
  assert.equal(report.slots.total, 3);
  assert.equal(report.slots.running, 1);
  assert.equal(report.allowed, true, 'a new create stays within 1 creating and 4 total');
});

test('workspace lifecycle normalization maps to conservative capacity categories', () => {
  assert.equal(categorizeWorkspace(workspaceFixture('provisioning')), 'creating');
  assert.equal(categorizeWorkspace(workspaceFixture('ready-without-setup-proof')), 'running');
  assert.equal(categorizeWorkspace(workspaceFixture('ready')), 'running');
  assert.equal(categorizeWorkspace(workspaceFixture('stopped')), 'stopped');
  assert.equal(categorizeWorkspace(workspaceFixture('recovery-required')), 'uncertain');
  assert.equal(categorizeWorkspace(workspaceFixture('identity-mismatch')), 'uncertain');
  assert.equal(categorizeWorkspace(workspaceFixture('resource-missing')), 'uncertain');
  assert.equal(categorizeWorkspace(workspaceFixture('unknown')), 'uncertain');
});

test('create intent states reserve conservative creating slots until they settle', () => {
  assert.equal(categorizeCreateIntent('intent-recorded'), 'creating');
  assert.equal(categorizeCreateIntent('create-dispatched'), 'creating');
  assert.equal(categorizeCreateIntent('resource-recorded'), 'creating');
  assert.equal(categorizeCreateIntent('identity-verified'), 'creating');
  assert.equal(categorizeCreateIntent('ambiguous-create'), 'uncertain');
  assert.equal(categorizeCreateIntent('recovery-required'), 'uncertain');
  assert.equal(categorizeCreateIntent('recovery-cleared'), undefined);
});

test('a global capacity lock serializes concurrent create decisions across processes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-capacity-'));
  let concurrent = 0;
  let maxConcurrent = 0;
  const enter = async () => {
    await withGlobalCapacityLock({ stateDir, policy, sample: async () => counted(), waitTimeoutMs: 5000 }, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      concurrent -= 1;
    });
  };
  await Promise.all([enter(), enter(), enter(), enter()]);
  assert.equal(maxConcurrent, 1, 'the global capacity lock must serialize create decisions');
});

test('a global capacity lock reaps a dead owner so capacity is not leaked by a crash', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-capacity-'));
  let entered = 0;
  await withGlobalCapacityLock({ stateDir, policy, sample: async () => counted(), waitTimeoutMs: 2000, ownerAlive: () => false }, async () => { entered += 1; });
  await withGlobalCapacityLock({ stateDir, policy, sample: async () => counted(), waitTimeoutMs: 2000, ownerAlive: () => false }, async () => { entered += 1; });
  assert.equal(entered, 2);
});

test('capacity sampling counts create intents before provider dispatch as creating', async () => {
  const { recordCreateIntent, listCreateIntents } = await import('../src/codespaces-ops.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-capacity-'));
  const requestId = '00000000-0000-4000-8000-0000000000aa';
  await recordCreateIntent(stateDir, {
    schemaVersion: 1, requestId, name: 'pending-create', createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
    capacity: { machine: 'basicLinux32gb', geo: 'EastUs', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, displayNameHint: null },
    state: 'intent-recorded', providerCorrelationId: null, providerError: null, providerResource: null, updatedAt: '2026-09-02T12:00:00.000Z', recoveryContext: null,
  }, { expectAbsent: true });
  const sampled: CapacityCountedWorkspace[] = (await listCreateIntents(stateDir)).flatMap((summary) => {
    const category = categorizeCreateIntent(summary.state);
    return category ? [{ name: summary.name, category }] : [];
  });
  const report = capacityReport([{ name: 'someone-else', category: 'running' }, ...sampled], policy);
  assert.equal(report.slots.total, 2, 'a durable un-dispatched intent consumes a conservative creating slot');
  assert.equal(report.slots.creating, 1);
});