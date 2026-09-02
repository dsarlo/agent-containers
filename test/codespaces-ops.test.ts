import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listCreateIntents, loadCreateIntent, loadCodespacesJournal, recordCodespacesEvent, recordCreateIntent, updateCreateIntent, codespacesOpsDir, type CodespacesCreateIntent } from '../src/codespaces-ops.js';
import type { CodespacesResource } from '../src/codespaces.js';

function resourceFixture(): CodespacesResource {
  return {
    id: '9876543210',
    name: 'bookish-space-parakeet',
    displayName: 'bookish-space-parakeet',
    environmentId: '8f1c1f0e-8e5f-4c2e-9b0a-1234567890ab',
    owner: { id: '1', login: 'octo' },
    repositoryId: '42',
    repository: { owner: 'octo', name: 'agent-containers' },
    billingOwner: { id: '1', login: 'octo' },
    devcontainerPath: '.devcontainer/devcontainer.json',
    machineName: 'basicLinux32gb',
    location: 'East US',
    geo: 'EastUs',
    createdAt: '2026-09-02T12:00:00Z',
    state: 'Running',
    gitStatus: { sha: '0123456789012345678901234567890123456789', ref: 'main' },
    idleTimeoutMinutes: 30,
  };
}

function fixtureIntent(overrides: Partial<CodespacesCreateIntent> = {}): CodespacesCreateIntent {
  return {
    schemaVersion: 1,
    requestId: randomUUID(),
    name: 'issue-9',
    createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
    capacity: { machine: 'basicLinux32gb', geo: 'EastUs', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, displayNameHint: null },
    state: 'intent-recorded',
    providerCorrelationId: null,
    providerError: null,
    providerResource: null,
    updatedAt: '2026-09-02T12:00:00.000Z',
    recoveryContext: null,
    ...overrides,
  };
}

test('create intent is durably recorded before any provider dispatch and survives reload', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const intent = fixtureIntent();
  await recordCreateIntent(stateDir, intent, { expectAbsent: true });
  const reloaded = await loadCreateIntent(stateDir, intent.requestId);
  assert.deepEqual(reloaded, intent);
  assert.equal(reloaded?.state, 'intent-recorded');
  assert.equal(reloaded?.source.expectedOid, '0123456789012345678901234567890123456789');
});

test('duplicate local request ID fails closed and never overwrites the recorded intent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const intent = fixtureIntent({ state: 'create-dispatched' });
  await recordCreateIntent(stateDir, intent, { expectAbsent: true });
  await assert.rejects(() => recordCreateIntent(stateDir, fixtureIntent({ requestId: intent.requestId }), { expectAbsent: true }), /duplicate local request ID/i);
  const reloaded = await loadCreateIntent(stateDir, intent.requestId);
  assert.equal(reloaded?.state, 'create-dispatched');
});

test('intent updates are CAS-bound and cannot silently downgrade a settled resource', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const intent = fixtureIntent();
  await recordCreateIntent(stateDir, intent, { expectAbsent: true });
  const updated = { ...intent, state: 'resource-recorded' as const, providerResource: resourceFixture(), updatedAt: '2026-09-02T12:05:00.000Z' };
  await updateCreateIntent(stateDir, updated, { expectedState: 'intent-recorded' });
  assert.equal((await loadCreateIntent(stateDir, intent.requestId))?.state, 'resource-recorded');
  await assert.rejects(
    () => updateCreateIntent(stateDir, { ...intent, state: 'provider-error' as const, updatedAt: '2026-09-02T13:00:00.000Z' }, { expectedState: 'intent-recorded' }),
    /expected state/i,
  );
  assert.equal((await loadCreateIntent(stateDir, intent.requestId))?.state, 'resource-recorded');
});

test('crash between intent and create leaves a durable intent and no metadata record', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const intent = fixtureIntent();
  await recordCreateIntent(stateDir, intent, { expectAbsent: true });
  assert.deepEqual(await listCreateIntents(stateDir), [{ requestId: intent.requestId, name: intent.name, state: 'intent-recorded', createdAt: intent.createdAt, expectedOid: intent.source.expectedOid }]);
  await assert.rejects(() => readdir(join(stateDir, 'workspaces')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('ambiguous-create recovery evidence is durable and lists only immutable hints', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const intent = fixtureIntent({ state: 'ambiguous-create', providerCorrelationId: 'req_50301', providerError: 'POST timed out after creation was possible', recoveryContext: { reason: 'provider-timeout-after-creation-possible', recordedAt: '2026-09-02T12:10:00.000Z', observedRemoteState: null } });
  await recordCreateIntent(stateDir, intent, { expectAbsent: true });
  const recovered = await loadCreateIntent(stateDir, intent.requestId);
  assert.equal(recovered?.state, 'ambiguous-create');
  assert.equal(recovered?.providerCorrelationId, 'req_50301');
});

test('journal is append-only, checksummed, and fails closed on corruption before the final record', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const operationId = randomUUID();
  await recordCodespacesEvent(stateDir, { event: 'operation-created', workspaceName: 'issue-9', operationId, requestId: randomUUID(), actorId: '1', repositoryId: '42', codespaceId: null, previous: null, next: 'create-intent', detail: 'intent recorded before dispatch' });
  await recordCodespacesEvent(stateDir, { event: 'provider-request-dispatched', workspaceName: 'issue-9', operationId, requestId: null, actorId: '1', repositoryId: '42', codespaceId: null, previous: 'create-intent', next: 'create-dispatched', detail: null });
  assert.equal((await loadCodespacesJournal(stateDir, 'issue-9')).length, 2);
  const journalPath = join(codespacesOpsDir(stateDir), '..', 'events', 'issue-9.journal');
  await writeFile(journalPath, (await readFile(journalPath, 'utf8')).replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'a'.repeat(64)}"`));
  await assert.rejects(() => loadCodespacesJournal(stateDir, 'issue-9'), /corrupt/);
});

test('refuses to persist secret-shaped values in any journal or intent field', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const hidden = 'github_pat_' + 'abcdefghijklmnopqrstuvwxyz1234567890';
  await assert.rejects(() => recordCreateIntent(stateDir, fixtureIntent({ capacity: { ...fixtureIntent({}).capacity, machine: hidden } }), { expectAbsent: true }), (error: Error) => !error.message.includes(hidden));
  await assert.rejects(() => recordCodespacesEvent(stateDir, { event: 'identity-mismatch', workspaceName: 'issue-9', operationId: randomUUID(), requestId: null, actorId: hidden, repositoryId: '42', codespaceId: null, previous: null, next: 'identity-mismatch', detail: null }), (error: Error) => !error.message.includes(hidden));
  assert.equal(await loadCreateIntent(stateDir, fixtureIntent().requestId), undefined);
  assert.deepEqual(await listCreateIntents(stateDir), []);
});

test('state write support failures block intent publication before any provider side effect', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-ops-'));
  const { setCodespacesOpsDurabilityAdapterForTesting } = await import('../src/codespaces-ops.js');
  try {
    setCodespacesOpsDurabilityAdapterForTesting({
      publicationMode: async () => 'strict',
      assertStateWriteSupport: async () => { throw new Error('durability unavailable'); },
      syncFile: async () => undefined,
      syncDirectory: async () => undefined,
      moveFileWriteThrough: async () => undefined,
    });
    await assert.rejects(() => recordCreateIntent(stateDir, fixtureIntent(), { expectAbsent: true }), /durability unavailable/);
  } finally {
    setCodespacesOpsDurabilityAdapterForTesting(undefined);
  }
});