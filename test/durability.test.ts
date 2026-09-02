import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
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
  const fixture = join(parse(process.cwd()).root, 'opt', 'agent-containers', 'dist', 'src', 'durability.js');
  assert.equal(nativeAddonPackageRoot(pathToFileURL(fixture).href), join(parse(process.cwd()).root, 'opt', 'agent-containers'));
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

test('native Windows access-denied move failures map to EPERM', async () => {
  const adapter = createNativeDurabilityAdapter(binding({
    moveFileWriteThrough: (source, destination) => ({
      ok: false,
      source,
      destination,
      method: 'move-file-write-through',
      windowsError: 'ERROR_ACCESS_DENIED',
      error: 'Access is denied.',
    }),
  }));

  await assert.rejects(
    () => adapter.moveFileWriteThrough('/state/source', '/state/destination'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as NodeJS.ErrnoException).code, 'EPERM');
      return true;
    },
  );
});

test('a native Windows contention result retains its machine-readable code and serializes lifecycle locks', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-windows-contention-')), 'state');
  const adapter = createNativeDurabilityAdapter(binding({
    capabilities: () => ({ regularFileSync: true, directorySync: false, writeThroughMove: true }),
    moveFileWriteThrough: async (source, destination) => {
      try {
        await lstat(destination);
        throw Object.assign(new Error('Windows directory collision'), { code: 'EEXIST' });
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          await rename(source, destination);
          return { ok: true, source, destination, method: 'move-file-write-through' };
        }
        if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
          return { ok: false, source, destination, method: 'move-file-write-through', code: error.code, error: error instanceof Error ? error.message : String(error) };
        }
        throw error;
      }
    },
  }));
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  let firstStarted!: () => void;
  const firstHasStarted = new Promise<void>((resolveFirstStarted) => { firstStarted = resolveFirstStarted; });
  const first = withWorkspaceLock(stateDir, 'safe', async () => {
    events.push('first-start');
    firstStarted();
    await firstMayFinish;
    events.push('first-end');
  }, { durabilityAdapter: adapter });
  await firstHasStarted;
  const second = withWorkspaceLock(stateDir, 'safe', async () => { events.push('second'); }, { durabilityAdapter: adapter });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('a native recovery-lock collision retries only after its valid owner retires', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-windows-recovery-retirement-race-')), 'state');
  let recoveryPublications = 0;
  let collisionObserved!: () => void;
  const collisionWasObserved = new Promise<void>((resolveCollision) => { collisionObserved = resolveCollision; });
  let ownerRetired!: () => void;
  const ownerWasRetired = new Promise<void>((resolveRetirement) => { ownerRetired = resolveRetirement; });
  const adapter = createNativeDurabilityAdapter(binding({
    capabilities: () => ({ regularFileSync: true, directorySync: false, writeThroughMove: true }),
    moveFileWriteThrough: async (source, destination) => {
      try {
        await lstat(destination);
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          await rename(source, destination);
          if (destination.endsWith('safe.recovery')) recoveryPublications += 1;
          return { ok: true, source, destination, method: 'move-file-write-through' };
        }
        throw error;
      }
      if (destination.endsWith('safe.recovery') && recoveryPublications === 1) {
        collisionObserved();
        await ownerWasRetired;
      }
      return { ok: false, source, destination, method: 'move-file-write-through', code: 'EEXIST', error: 'Windows directory collision' };
    },
  }));
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  let firstStarted!: () => void;
  const firstHasStarted = new Promise<void>((resolveFirstStarted) => { firstStarted = resolveFirstStarted; });
  const first = withWorkspaceLock(stateDir, 'safe', async () => {
    events.push('first-start');
    firstStarted();
    await firstMayFinish;
    events.push('first-end');
  }, { durabilityAdapter: adapter });
  await firstHasStarted;
  const second = withWorkspaceLock(stateDir, 'safe', async () => { events.push('second'); }, { durabilityAdapter: adapter });

  await collisionWasObserved;
  releaseFirst();
  await first;
  ownerRetired();
  await second;

  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('a raw rename EPERM after an absent destination remains surfaced', async () => {
  const destination = join(await mkdtemp(join(tmpdir(), 'agent-containers-windows-raw-rename-error-')), 'destination');
  const rawRenameError = Object.assign(new Error('simulated raw rename permission denied'), { code: 'EPERM' });
  const adapter = createNativeDurabilityAdapter(binding({
    capabilities: () => ({ regularFileSync: true, directorySync: false, writeThroughMove: true }),
    moveFileWriteThrough: async (source, observedDestination) => {
      try {
        await lstat(observedDestination);
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') throw rawRenameError;
        throw error;
      }
      return { ok: false, source, destination: observedDestination, method: 'move-file-write-through', code: 'EEXIST', error: 'Windows directory collision' };
    },
  }));

  await assert.rejects(
    () => adapter.moveFileWriteThrough('source', destination),
    (error: unknown) => error === rawRenameError,
  );
});

test('a native collision with a malformed published recovery lock fails closed without replacing it', async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-windows-recovery-malformed-')), 'state');
  const recoveryPath = join(stateDir, 'locks', 'safe.recovery');
  await mkdir(recoveryPath, { recursive: true });
  const adapter = createNativeDurabilityAdapter(binding({
    capabilities: () => ({ regularFileSync: true, directorySync: false, writeThroughMove: true }),
    moveFileWriteThrough: async (source, destination) => {
      try {
        await lstat(destination);
        throw Object.assign(new Error('Windows directory collision'), { code: 'EEXIST' });
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          await rename(source, destination);
          return { ok: true, source, destination, method: 'move-file-write-through' };
        }
        if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
          return { ok: false, source, destination, method: 'move-file-write-through', code: error.code, error: error instanceof Error ? error.message : String(error) };
        }
        throw error;
      }
    },
  }));
  let ran = false;

  await assert.rejects(
    () => withWorkspaceLock(stateDir, 'safe', async () => { ran = true; }, { timeoutMs: 0, durabilityAdapter: adapter }),
    /malformed owner metadata/i,
  );
  assert.equal(ran, false, 'a malformed recovery lock cannot be adopted as lifecycle ownership');
  assert.equal((await lstat(recoveryPath)).isDirectory(), true, 'the malformed recovery lock remains for verified manual repair');
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
