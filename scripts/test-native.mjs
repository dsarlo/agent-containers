import assert from 'node:assert/strict';
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process, { stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = process.env.PACKED_NATIVE_PACKAGE_DIR
  ? resolve(process.env.PACKED_NATIVE_PACKAGE_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { getProductionStateDurabilityAdapter } = await import(pathToFileURL(join(packageRoot, 'dist/src/durability.js')).href);
const {
  clearManualRecovery,
  loadManualRecovery,
  loadMetadata,
  metadataPath,
  recordManualRecovery,
  saveMetadata,
  withWorkspaceLock,
} = await import(pathToFileURL(join(packageRoot, 'dist/src/state.js')).href);
const directory = await mkdtemp(join(tmpdir(), 'agent-containers-native-state-'));
const stateDir = join(directory, 'state');
const name = 'native-smoke';
const truncatedJournalName = 'native-truncated';
const source = join(directory, 'source.json');
const destination = join(directory, 'published.json');
const payload = JSON.stringify({ protocol: 'native-durability-smoke' });
const metadata = {
  version: 1,
  name,
  repoRoot: directory,
  worktree: directory,
  branch: `agent-containers/${name}`,
  baseRef: 'refs/heads/main',
  devcontainerPath: '.devcontainer/devcontainer.json',
  createdAt: new Date().toISOString(),
};

async function assertMissing(path, description) {
  await assert.rejects(lstat(path), { code: 'ENOENT' }, description);
}

try {
  const adapter = getProductionStateDurabilityAdapter();
  await adapter.assertStateWriteSupport();
  await writeFile(source, payload, 'utf8');
  await adapter.syncFile(source);

  const mode = await adapter.publicationMode();
  assert.ok(mode === 'strict' || mode === 'recoverable', `unexpected native publication mode: ${mode}`);
  if (process.env.EXPECTED_NATIVE_PUBLICATION_MODE) {
    assert.equal(mode, process.env.EXPECTED_NATIVE_PUBLICATION_MODE, 'native adapter must use the platform-specific production publication mode');
  }
  if (mode === 'recoverable') {
    assert.equal(process.platform, 'win32', 'recoverable publication is the Windows production protocol');
    await adapter.moveFileWriteThrough(source, destination);
    assert.equal(await readFile(destination, 'utf8'), payload, 'write-through publication must preserve the exact payload');
  } else {
    assert.equal(await readFile(source, 'utf8'), payload, 'strict file sync must preserve the exact payload');
  }

  // These calls use state.ts's production adapter resolution; no test adapter is injected.
  await saveMetadata(stateDir, metadata);
  assert.deepEqual(await loadMetadata(stateDir, name), metadata, 'production metadata publication must round-trip');
  assert.equal(
    await readFile(metadataPath(stateDir, name), 'utf8'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'production metadata publication must persist the exact state record',
  );

  const lockPath = join(stateDir, 'locks', `${name}.lock`);
  let lockWasPublished = false;
  await withWorkspaceLock(stateDir, name, async (signal) => {
    assert.equal(signal.aborted, false, 'newly acquired production lock must provide a live cancellation signal');
    await lstat(join(lockPath, 'owner.json'));
    lockWasPublished = true;
  });
  assert.equal(lockWasPublished, true, 'production workspace lock must be published before lifecycle action');
  await assertMissing(lockPath, 'production workspace lock must be released after lifecycle action');

  const recoveryInput = {
    reason: 'operation-may-be-active',
    containerIds: ['native-smoke-container'],
    worktree: directory,
  };
  await recordManualRecovery(stateDir, name, recoveryInput);
  const recordedRecovery = await loadManualRecovery(stateDir, name);
  assert.ok(recordedRecovery, 'production manual recovery journal must retain its set record');
  assert.equal(recordedRecovery.reason, recoveryInput.reason);
  assert.deepEqual(recordedRecovery.containerIds, recoveryInput.containerIds);
  assert.equal(recordedRecovery.worktree, recoveryInput.worktree);
  await clearManualRecovery(stateDir, name);
  assert.equal(await loadManualRecovery(stateDir, name), undefined, 'production manual recovery clear must release its journal barrier');

  await recordManualRecovery(stateDir, truncatedJournalName, recoveryInput);
  const truncatedJournalPath = join(stateDir, 'locks', `${truncatedJournalName}.manual-recovery.journal`);
  await appendFile(truncatedJournalPath, '{"event":"clear"', 'utf8');
  const recoveredFromTruncatedJournal = await loadManualRecovery(stateDir, truncatedJournalName);
  assert.ok(recoveredFromTruncatedJournal, 'a truncated journal tail must preserve the earlier production recovery block');
  assert.equal(recoveredFromTruncatedJournal.reason, recoveryInput.reason);
  assert.deepEqual(recoveredFromTruncatedJournal.containerIds, recoveryInput.containerIds);

  stdout.write(`Native production state lifecycle smoke passed (${mode}).\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
