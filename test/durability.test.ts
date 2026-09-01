import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createNativeDurabilityAdapter, nativeAddonPackageRoot, type NativeDurabilityBinding, type StateDurabilityAdapter } from '../src/durability.js';
import { withWorkspaceLock } from '../src/state.js';

function binding(overrides: Partial<NativeDurabilityBinding> = {}): NativeDurabilityBinding {
  return {
    capabilities: () => ({ regularFileSync: true, directorySync: true, writeThroughMove: false }),
    syncPath: (path) => ({ ok: true, path, target: 'file', method: 'fsync' }),
    moveFileWriteThrough: (source, destination) => ({ ok: true, source, destination, method: 'move-file-write-through' }),
    ...overrides,
  };
}

test('production native addon loading starts at the package root rather than dist/src', () => {
  assert.equal(nativeAddonPackageRoot('file:///opt/agent-containers/dist/src/durability.js'), '/opt/agent-containers');
});

test('native durability adapter preserves macOS full-sync file results and reports unsupported directory durability', async () => {
  const calls: string[] = [];
  const adapter = createNativeDurabilityAdapter(binding({
    capabilities: () => ({ regularFileSync: true, directorySync: false, writeThroughMove: false }),
    syncPath: (path) => {
      calls.push(path);
      return path.endsWith('.json')
        ? { ok: true, path, target: 'file', method: 'fullfsync' }
        : { ok: false, path, target: 'directory', method: 'unsupported', error: 'F_FULLFSYNC is not available for directories' };
    },
  }));

  await adapter.syncFile('/state/workspace.json');
  await assert.rejects(() => adapter.syncDirectory('/state'), /F_FULLFSYNC is not available for directories/);
  assert.deepEqual(calls, ['/state/workspace.json', '/state']);
});

test('Windows file flush and write-through move select recoverable publication rather than rejecting state writes', async () => {
  const adapter = createNativeDurabilityAdapter(binding({
    capabilities: () => ({ regularFileSync: true, directorySync: false, writeThroughMove: true }),
  }));

  await adapter.assertStateWriteSupport();
  assert.equal(await adapter.publicationMode(), 'recoverable');
});

test('state lifecycle fails closed before creating state or invoking its action when required durability is unavailable', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-durability-')), 'state');
  let actionRan = false;
  const unavailable: StateDurabilityAdapter = {
    publicationMode: async () => { throw new Error('Native durability addon could not be loaded.'); },
    assertStateWriteSupport: async () => { throw new Error('Native durability addon could not be loaded.'); },
    syncFile: async () => undefined,
    syncDirectory: async () => undefined,
    moveFileWriteThrough: async () => undefined,
  };

  await assert.rejects(
    () => withWorkspaceLock(stateDir, 'safe', async () => { actionRan = true; }, { durabilityAdapter: unavailable }),
    /native durability addon/i,
  );
  await assert.rejects(() => access(stateDir));
  assert.equal(actionRan, false);
});
