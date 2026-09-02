import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhCodespacesProvider, type CodespacesProviderProcess } from '../src/codespaces.js';
import {
  bootstrapRemoteHelper,
  helperArchForUname,
  inspectRemoteHelper,
  loadHelperManifest,
  loadLocalHelperBootstrap,
  type HelperManifest,
  type RemoteHelperBootstrapDependencies,
} from '../src/codespaces-helper.js';
import { HELPER_PROTOCOL_VERSION } from '../src/codespaces-protocol.js';

const WORKSPACE_NAME = 'issue-9';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const BOOT_ID = '11111111-2222-4333-8444-555555555555';

const FIXTURE_X64 = Buffer.from('ELF-fake-agent-containers-helper-x64');
const FIXTURE_ARM64 = Buffer.from('ELF-fake-agent-containers-helper-arm64');

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildManifest(overrides: { x64Sha?: string; protocol?: number; mode?: string; archMode?: string } = {}): HelperManifest {
  const manifest: HelperManifest = {
    schemaVersion: 1,
    protocol: overrides.protocol ?? HELPER_PROTOCOL_VERSION,
    helperVersion: '0.1.0',
    architectures: {
      'linux-x64': { file: 'agent-containers-helper-linux-x64', sha256: overrides.x64Sha ?? digest(FIXTURE_X64), size: FIXTURE_X64.length, mode: overrides.archMode ?? '0755' },
      'linux-arm64': { file: 'agent-containers-helper-linux-arm64', sha256: digest(FIXTURE_ARM64), size: FIXTURE_ARM64.length, mode: overrides.archMode ?? '0755' },
    },
    sourcePins: { 'helper.c': '0'.repeat(64), Makefile: '1'.repeat(64) },
    artifactsStaged: true,
    selfChecksum: '',
    generatedAt: '2026-09-02T12:00:00.000Z',
  };
  manifest.selfChecksum = createHash('sha256').update(JSON.stringify({ ...manifest, selfChecksum: undefined })).digest('hex');
  return manifest;
}

async function fixtureRoot(manifest = buildManifest()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-helper-fixture-'));
  await mkdir(join(root, 'native', 'helper', 'bin'), { recursive: true });
  await writeFile(join(root, 'native', 'helper', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-x64'), FIXTURE_X64);
  await writeFile(join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-arm64'), FIXTURE_ARM64);
  return root;
}

interface SshOverrides {
  uname?: string;
  sha256For?: (path: string) => string;
  statFor?: (path: string) => string;
  handshake?: string;
  uid?: string;
}

function bootstrapProcess(options: { overrides?: SshOverrides; onArgs?: (args: string[], runOptions?: object) => void; mutateSsh?: (args: string[]) => { code: number; stdout?: string; stderr?: string; input?: unknown } } = {}): CodespacesProviderProcess {
  const overrides = options.overrides ?? {};
  return {
    async run(command, args, runOptions) {
      assert.equal(command, 'gh');
      options.onArgs?.(args, runOptions);
      const trailing = args.join(' ');
      if (!trailing.startsWith('codespace ssh -c bookish-space-parakeet -- ')) throw new Error(`unrouted ssh argv: ${JSON.stringify(args)}`);
      if (options.mutateSsh) {
        const mutated = options.mutateSsh(args);
        if (mutated !== undefined) return { code: mutated.code, stdout: mutated.stdout ?? '', stderr: mutated.stderr ?? '' };
      }
      const remote = args.slice(args.indexOf('--') + 1);
      const argv = remote.join(' ');
      if (argv === 'uname -m') return { code: 0, stdout: `${overrides.uname ?? 'x86_64'}\n`, stderr: '' };
      if (argv === 'id -u') return { code: 0, stdout: `${overrides.uid ?? '1000'}\n`, stderr: '' };
      if (argv.startsWith('mkdir -p')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('chmod 0700 ')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('mv ')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('tee ')) {
        assert.ok(runOptions?.binaryInput !== undefined, 'the helper copy must stream package-owned bytes on stdin');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv.startsWith('sha256sum ')) {
        const path = argv.split(' ')[1];
        const value = overrides.sha256For ? overrides.sha256For(path) : digest(FIXTURE_X64);
        return { code: 0, stdout: `${value}  ${path}\n`, stderr: '' };
      }
      if (argv.startsWith('stat -c %F|%a|%u|%g ')) {
        const path = argv.split(' ').at(-1) as string;
        return { code: 0, stdout: `${overrides.statFor ? overrides.statFor(path) : 'regular file|700|1000|1000'}\n`, stderr: '' };
      }
      if (argv.endsWith(' handshake')) {
        return { code: 0, stdout: `${overrides.handshake ?? `agent-containers-helper v0.1.0 protocol=${HELPER_PROTOCOL_VERSION} arch=x86_64 boot=${BOOT_ID}`}\n`, stderr: '' };
      }
      throw new Error(`unrouted remote argv: ${argv}`);
    },
  };
}

async function bootstrapDeps(runner: CodespacesProviderProcess, root: string, verifyKnown: boolean): Promise<RemoteHelperBootstrapDependencies> {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-helper-state-')), 'state');
  return {
    stateDir, workspaceName: WORKSPACE_NAME, workspaceId: WORKSPACE_ID, remoteName: 'bookish-space-parakeet',
    provider: new GhCodespacesProvider(runner), root, verifyKnown, now: () => '2026-09-02T12:00:00.000Z',
  };
}

test('the helper manifest pins exactly the two Codespaces architectures with checksummed digests', async () => {
  const root = await fixtureRoot();
  const manifest = await loadHelperManifest(root);
  assert.deepEqual(Object.keys(manifest.architectures).sort(), ['linux-arm64', 'linux-x64']);
  assert.equal(manifest.protocol, HELPER_PROTOCOL_VERSION);
  assert.match(manifest.selfChecksum, /^[0-9a-f]{64}$/);
  await rm(root, { recursive: true, force: true });
});

test('helper architecture mapping covers x64 and arm64 and rejects unknown architectures', () => {
  assert.equal(helperArchForUname('x86_64'), 'linux-x64');
  assert.equal(helperArchForUname('aarch64'), 'linux-arm64');
  assert.equal(helperArchForUname('armv7l'), undefined);
  assert.equal(helperArchForUname('s390x'), undefined);
});

test('bootstrap copies only the package-owned artifact over controlled argv and verifies everything before execution', async () => {
  const root = await fixtureRoot();
  const dispatched: Array<[string[], { binaryInput?: unknown } | undefined]> = [];
  const runner = bootstrapProcess({ onArgs: (args, runOptions) => dispatched.push([args, runOptions as { binaryInput?: unknown }]) });
  const deps = await bootstrapDeps(runner, root, false);
  const result = await bootstrapRemoteHelper(deps);
  assert.equal(result.arch, 'linux-x64');
  assert.equal(result.protocolVersion, HELPER_PROTOCOL_VERSION);
  assert.equal(result.remoteBootId, BOOT_ID);
  assert.equal(result.binPath, '/workspaces/.agent-containers/00000000-0000-4000-8000-000000000001/bin/agent-containers-helper-linux-x64');
  const argv = dispatched.map(([args]) => args.slice(args.indexOf('--') + 1).join(' '));
  assert.ok(argv.some((line) => line === 'uname -m'));
  assert.ok(argv.some((line) => line === `mkdir -p /workspaces/.agent-containers/${WORKSPACE_ID}/bin`));
  const tee = dispatched.find(([args]) => args.slice(args.indexOf('--') + 1)[0] === 'tee');
  assert.ok(tee, 'the copy must use the fixed argv-framed tee transport');
  assert.ok(Buffer.compare(Buffer.from(tee?.[1]?.binaryInput as Uint8Array ?? new Uint8Array(0)), FIXTURE_X64) === 0, 'only the package-owned artifact bytes are copied');
  assert.ok(argv.some((line) => line.endsWith(' handshake')));
  assert.ok(dispatched.every(([args]) => args.every((value) => value === '%F|%a|%u|%g' || !/[;&$`\\(){}]/.test(value))), 'no shell interpolation may reach the remote argv');
  const record = await loadLocalHelperBootstrap(deps.stateDir, WORKSPACE_NAME);
  assert.ok(record && record.sha256 === digest(FIXTURE_X64) && record.protocolVersion === HELPER_PROTOCOL_VERSION);
  await rm(root, { recursive: true, force: true });
});

test('bootstrap blocks execution on a mismatched remote architecture (no fallback)', async () => {
  const root = await fixtureRoot();
  const runner = bootstrapProcess({ overrides: { uname: 'armv7l' } });
  const deps = await bootstrapDeps(runner, root, false);
  await assert.rejects(() => bootstrapRemoteHelper(deps), /architecture.*unsupported|no package-owned helper artifact/i);
  await rm(root, { recursive: true, force: true });
});

test('bootstrap blocks execution on a remote digest mismatch', async () => {
  const root = await fixtureRoot();
  const runner = bootstrapProcess({ overrides: { sha256For: () => 'f'.repeat(64) } });
  const deps = await bootstrapDeps(runner, root, false);
  await assert.rejects(() => bootstrapRemoteHelper(deps), /digest mismatch|blocked/i);
  await rm(root, { recursive: true, force: true });
});

test('bootstrap blocks execution on the wrong owner, mode, type, and group', async () => {
  const root = await fixtureRoot();
  for (const [statFor, match] of [
    [() => 'regular file|700|0|1000', /owner does not match|root-owned/i],
    [() => 'regular file|700|1000|0', /group is root-owned/i],
    [() => 'symbolic link|777|1000|1000', /not a regular file/i],
    [() => 'regular file|755|1000|1000', /mode.*0700/i],
  ] as Array<[() => string, RegExp]>) {
    const runner = bootstrapProcess({ overrides: { statFor } });
    const deps = await bootstrapDeps(runner, root, false);
    await assert.rejects(() => bootstrapRemoteHelper(deps), match);
  }
  const rootUid = bootstrapProcess({ overrides: { uid: '0' } });
  const uidDeps = await bootstrapDeps(rootUid, root, false);
  await assert.rejects(() => bootstrapRemoteHelper(uidDeps), /Could not verify the remote helper owner/i);
  await rm(root, { recursive: true, force: true });
});

test('bootstrap blocks execution on a protocol or architecture handshake mismatch', async () => {
  const root = await fixtureRoot();
  for (const [handshake, match] of [
    [`agent-containers-helper v0.1.0 protocol=99 arch=x86_64 boot=${BOOT_ID}`, /protocol/],
    [`agent-containers-helper v0.1.0 protocol=1 arch=armv7l boot=${BOOT_ID}`, /architecture/],
    [`unexpected banner`, /protocol handshake/i],
  ] as Array<[string, RegExp]>) {
    const runner = bootstrapProcess({ overrides: { handshake } });
    const deps = await bootstrapDeps(runner, root, false);
    await assert.rejects(() => bootstrapRemoteHelper(deps), match);
  }
  await rm(root, { recursive: true, force: true });
});

test('bootstrap blocks when the package artifact is absent and never falls back to an arbitrary URL', async () => {
  const root = await fixtureRoot();
  await rm(join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-x64'), { force: true });
  const runner = bootstrapProcess();
  await assert.rejects(async () => bootstrapRemoteHelper(await bootstrapDeps(runner, root, false)), /refuses to fall back|absent/i);
  await rm(root, { recursive: true, force: true });
});

test('bootstrap rejects a tampered local artifact digest before any remote side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-helper-fixture-'));
  await mkdir(join(root, 'native', 'helper', 'bin'), { recursive: true });
  await writeFile(join(root, 'native', 'helper', 'manifest.json'), `${JSON.stringify(buildManifest({ x64Sha: '1'.repeat(64) }), null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-x64'), FIXTURE_X64);
  await writeFile(join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-arm64'), FIXTURE_ARM64);
  const remoteDispatches: string[] = [];
  const runner = bootstrapProcess({ onArgs: (args) => { remoteDispatches.push(args.slice(args.indexOf('--') + 1).join(' ')); } });
  await assert.rejects(async () => bootstrapRemoteHelper(await bootstrapDeps(runner, root, false)), /tampered artifact/i);
  assert.deepEqual(remoteDispatches, ['uname -m'], 'a tampered local artifact must stop before any copy or execution side effect');
  await rm(root, { recursive: true, force: true });
});

test('a known helper record verifies read-only and a changed remote digest blocks execution', async () => {
  const root = await fixtureRoot();
  const runner = bootstrapProcess();
  const deps = await bootstrapDeps(runner, root, false);
  await bootstrapRemoteHelper(deps);
  const verifyRunner = bootstrapProcess({ overrides: { sha256For: (path) => (path.endsWith('agent-containers-helper-linux-x64') ? digest(FIXTURE_X64) : digest(FIXTURE_X64)) } });
  const result = await inspectRemoteHelper(await bootstrapDeps(verifyRunner, root, true), 'linux-x64', 'agent-containers-helper-linux-x64');
  assert.equal(result.sha256, digest(FIXTURE_X64));
  const tampered = bootstrapProcess({ overrides: { sha256For: () => 'f'.repeat(64) } });
  await assert.rejects(async () => inspectRemoteHelper(await bootstrapDeps(tampered, root, true), 'linux-x64', 'agent-containers-helper-linux-x64'), /digest mismatch|blocked/i);
  await rm(root, { recursive: true, force: true });
});

test('the helper manifest self-check fails closed on a corrupt checksum', async () => {
  const root = await fixtureRoot(buildManifest());
  const path = join(root, 'native', 'helper', 'manifest.json');
  const source = JSON.parse(await readFile(path, 'utf8'));
  source.selfChecksum = '0'.repeat(64);
  await writeFile(path, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
  await assert.rejects(() => loadHelperManifest(root), /fails its own checksum/i);
  await rm(root, { recursive: true, force: true });
});