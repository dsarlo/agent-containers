import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRequestHash } from '../src/codespaces-protocol.js';
import {
  clearCommandRecovery,
  codespacesCommandDir,
  loadCommandOffsets,
  loadCommandRecovery,
  loadCommandRequest,
  loadCommandStatus,
  recordCommandRecovery,
  recordCommandRequest,
  resolveCommandIdempotency,
  saveCommandOffsets,
  saveCommandStatus,
  type CodespacesCommandOffsets,
  type CodespacesCommandRequest,
  type CodespacesCommandStatus,
} from '../src/codespaces-command.js';
import { recordCodespacesEvent, loadCodespacesJournal } from '../src/codespaces-ops.js';

const COMMAND_ID = 'cmd-issue-9-shell';
const WORKSPACE = 'issue-9';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const SECRET_FIXTURE = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz123456';

function requestFixture(hash = computeRequestHash(['echo', 'hello'], '/workspaces/agent-containers', 'pipe')): CodespacesCommandRequest {
  return {
    schemaVersion: 1, commandId: COMMAND_ID, requestHash: hash, workspaceName: WORKSPACE, workspaceId: WORKSPACE_ID,
    argvCount: 2, mode: 'pipe', cwd: '/workspaces/agent-containers', createdAt: '2026-09-02T12:00:00.000Z',
  };
}

function statusFixture(state: CodespacesCommandStatus['state']): CodespacesCommandStatus {
  return {
    schemaVersion: 1, commandId: COMMAND_ID, state, exitCode: null, transport: 'connected',
    createdAt: '2026-09-02T12:00:00.000Z', startedAt: null, exitedAt: null, updatedAt: '2026-09-02T12:00:01.000Z',
  };
}

async function stateDirFixture(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'agent-containers-command-')), 'state');
}

test('a new command request records durably and resolves to created; the same ID and hash attaches (idempotent)', async () => {
  const stateDir = await stateDirFixture();
  const hash = computeRequestHash(['printf', '%s', 'x'], '/workspaces/agent-containers', 'pipe');
  assert.equal(await resolveCommandIdempotency(stateDir, COMMAND_ID, hash), 'created');
  await recordCommandRequest(stateDir, requestFixture(hash), { expectAbsent: true });
  assert.equal(await resolveCommandIdempotency(stateDir, COMMAND_ID, hash), 'attach');
  const request = await loadCommandRequest(stateDir, COMMAND_ID);
  assert.equal(request?.requestHash, hash);
});

test('reusing a command ID with a different argv hash fails without overwriting the durable request (N6)', async () => {
  const stateDir = await stateDirFixture();
  const original = computeRequestHash(['printf', '%s', 'x'], '/workspaces/agent-containers', 'pipe');
  await recordCommandRequest(stateDir, requestFixture(original), { expectAbsent: true });
  const changed = computeRequestHash(['printf', '%s', 'y'], '/workspaces/agent-containers', 'pipe');
  await assert.rejects(() => resolveCommandIdempotency(stateDir, COMMAND_ID, changed), /different argv hash/);
  await assert.rejects(() => recordCommandRequest(stateDir, requestFixture(changed), { expectAbsent: true }), /already recorded/);
  assert.equal((await loadCommandRequest(stateDir, COMMAND_ID))?.requestHash, original);
});

test('status transitions are atomic and guard their expected prior state; corrupt status fails closed', async () => {
  const stateDir = await stateDirFixture();
  await recordCommandRequest(stateDir, requestFixture());
  await saveCommandStatus(stateDir, statusFixture('starting'));
  await assert.rejects(() => saveCommandStatus(stateDir, statusFixture('running'), { expectedState: 'accepted' }), /not at expected state/);
  assert.equal((await loadCommandStatus(stateDir, COMMAND_ID))?.state, 'starting', 'the guarded update to the wrong expected state must leave the prior record intact');
  await saveCommandStatus(stateDir, statusFixture('running'), { expectedState: 'starting' });
  await saveCommandStatus(stateDir, { ...statusFixture('exited'), exitCode: 5, exitedAt: '2026-09-02T12:00:02.000Z' }, { expectedState: 'running' });
  const exited = await loadCommandStatus(stateDir, COMMAND_ID);
  assert.equal(exited?.state, 'exited');
  assert.equal(exited?.exitCode, 5);
});

test('offsets persist as lossless nonnegative byte cursors and are reloadable', async () => {
  const stateDir = await stateDirFixture();
  const offsets: CodespacesCommandOffsets = {
    schemaVersion: 1, commandId: COMMAND_ID, stdout: '1048577', stderr: '0', terminal: '9007199254740993', updatedAt: '2026-09-02T12:00:01.000Z',
  };
  await saveCommandOffsets(stateDir, offsets);
  assert.deepEqual(await loadCommandOffsets(stateDir, COMMAND_ID), offsets);
});

test('corrupt command records fail closed and are never treated as absence', async () => {
  const stateDir = await stateDirFixture();
  const directory = codespacesCommandDir(stateDir, COMMAND_ID);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), '{broken', 'utf8');
  writeFileSync(join(directory, 'status.json'), 'not json', 'utf8');
  await assert.rejects(() => loadCommandRequest(stateDir, COMMAND_ID), /corrupt|not valid JSON|infer/);
  await assert.rejects(() => loadCommandStatus(stateDir, COMMAND_ID), /corrupt|not valid JSON|infer/);
});

test('recovery barriers are generation-gated and only the exact barrier can be cleared', async () => {
  const stateDir = await stateDirFixture();
  const recovery = await recordCommandRecovery(stateDir, { commandId: COMMAND_ID, workspaceName: WORKSPACE, reason: 'cancel-outcome-unknown' });
  assert.equal((await loadCommandRecovery(stateDir, COMMAND_ID))?.generation, recovery.generation);
  await assert.rejects(() => clearCommandRecovery(stateDir, COMMAND_ID, '00000000-0000-4000-8000-000000000000'), /newer barrier/);
  await clearCommandRecovery(stateDir, COMMAND_ID, recovery.generation);
  assert.equal(await loadCommandRecovery(stateDir, COMMAND_ID), undefined);
  await assert.rejects(() => clearCommandRecovery(stateDir, COMMAND_ID, recovery.generation), /no remote command recovery barrier/i);
});

test('the durable command record never persists argv plaintext or a secret-shaped value in any file (N7)', async () => {
  const stateDir = await stateDirFixture();
  const argv: string[] = ['sh', '-c', `echo ${SECRET_FIXTURE}`];
  const hash = computeRequestHash(argv, '/workspaces/agent-containers', 'pipe');
  await recordCommandRequest(stateDir, requestFixture(hash), { expectAbsent: true });
  await saveCommandStatus(stateDir, statusFixture('running'));
  await saveCommandOffsets(stateDir, { schemaVersion: 1, commandId: COMMAND_ID, stdout: '12', stderr: '0', terminal: '0', updatedAt: '2026-09-02T12:00:01.000Z' });
  await recordCodespacesEvent(stateDir, { event: 'command-accepted', workspaceName: WORKSPACE, operationId: '00000000-0000-4000-8000-0000000000dd', requestId: null, actorId: '1', repositoryId: '42', codespaceId: null, commandId: COMMAND_ID, requestHash: hash, previous: null, next: 'accepted', detail: null });
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const source = await readFile(path, 'utf8');
      files.push(source);
    }
  };
  await walk(codespacesCommandDir(stateDir, COMMAND_ID));
  await walk(join(stateDir, 'codespaces', 'events'));
  assert.ok(files.length > 0);
  assert.ok(files.every((source) => !source.includes(SECRET_FIXTURE)), 'no secret-shaped value may persist');
  assert.ok(files.every((source) => !source.includes('sh -c')), 'argv plaintext must not appear in durable command records');
  const journal = await loadCodespacesJournal(stateDir, WORKSPACE);
  assert.equal(journal.some((entry) => entry.commandId === COMMAND_ID && entry.requestHash === hash), true);
});