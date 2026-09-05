import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhCodespacesProvider, type CodespacesProviderProcess } from '../src/codespaces.js';
import { recordCodespacesEvent } from '../src/codespaces-ops.js';
import type { CodespacesWorkspaceMetadata, WorkspaceMetadata } from '../src/state.js';
import { saveMetadata } from '../src/state.js';
import { recordCreateIntent } from '../src/codespaces-ops.js';
import type { CodespacesAgentContainersConfig } from '../src/types.js';
import { HELPER_PROTOCOL_VERSION } from '../src/codespaces-protocol.js';
import type { RemoteTransportDependencies, SshSpawner } from '../src/codespaces-transport.js';
import { MockRemoteHelper, createMockSshSpawner } from './mock-helper.js';

export const OID = '0123456789abcdef0123456789abcdef01234567';
export const BLOB = '1234567890abcdef1234567890abcdef12345678';
export const COMMAND_ID = 'cmd-issue-9-shell';
export const WORKSPACE_NAME = 'issue-9';
export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const REMOTE_NAME = 'bookish-space-parakeet';
export const BOOT_ID = '11111111-2222-4333-8444-555555555555';

export const FIXTURE_X64 = Buffer.from('ELF-fake-agent-containers-helper-x64');
export const FIXTURE_ARM64 = Buffer.from('ELF-fake-agent-containers-helper-arm64');

export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface HelperFixtureRoot {
  root: string;
  manifest: Record<string, unknown>;
  x64Digest: string;
  arm64Digest: string;
}

export async function createHelperFixtureRoot(): Promise<HelperFixtureRoot> {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-helper-fixture-'));
  await mkdir(join(root, 'native', 'helper', 'bin'), { recursive: true });
  await writeFile(join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-x64'), FIXTURE_X64);
  await writeFile(join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-arm64'), FIXTURE_ARM64);
  const manifest = {
    schemaVersion: 1,
    protocol: HELPER_PROTOCOL_VERSION,
    helperVersion: '0.1.0',
    architectures: {
      'linux-x64': { file: 'agent-containers-helper-linux-x64', sha256: digest(FIXTURE_X64), size: FIXTURE_X64.length, mode: '0755' },
      'linux-arm64': { file: 'agent-containers-helper-linux-arm64', sha256: digest(FIXTURE_ARM64), size: FIXTURE_ARM64.length, mode: '0755' },
    },
    sourcePins: { 'helper.c': '0'.repeat(64), Makefile: '1'.repeat(64) },
    artifactsStaged: true,
    selfChecksum: '',
    generatedAt: '2026-09-02T12:00:00.000Z',
  };
  manifest.selfChecksum = createHash('sha256').update(JSON.stringify({ ...manifest, selfChecksum: undefined })).digest('hex');
  await writeFile(join(root, 'native', 'helper', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, manifest, x64Digest: digest(FIXTURE_X64), arm64Digest: digest(FIXTURE_ARM64) };
}

export function transportConfigFixture(): CodespacesAgentContainersConfig {
  return {
    version: 2,
    workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' },
    project: { repository: 'octo/agent-containers', ref: 'refs/heads/main', expectedOid: OID },
    environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    backends: {
      enabled: ['codespaces'], default: 'codespaces', local: {},
      codespaces: {
        enabled: true, machine: 'basicLinux32gb', geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080,
        maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1,
        readiness: { providerTimeoutSeconds: 2, sshTimeoutSeconds: 2, command: [], commandTimeoutSeconds: 2 },
        transport: { reconnectWindowSeconds: 1, cancelGraceSeconds: 1 },
        ports: { allowVisibilityChanges: false, allowPublic: false },
        secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false },
      },
    },
  };
}

export function recordedWorkspace(): CodespacesWorkspaceMetadata {
  return {
    version: 2, backend: 'codespaces', name: WORKSPACE_NAME, workspaceId: WORKSPACE_ID, createdAt: '2026-09-02T12:00:00.000Z',
    control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.52.0' },
    repository: { id: '42', owner: 'octo', name: 'agent-containers' },
    source: { requestedRef: 'refs/heads/main', expectedOid: OID, effectiveBranch: 'agent-containers/issue-9', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: BLOB },
    remote: { codespaceId: '9876543210', name: REMOTE_NAME, environmentId: 'env-8f1c1f0e', ownerId: '1', ownerLogin: 'octo', billableOwnerId: '1', machine: 'basicLinux32gb', geo: 'EastUs', createdAt: '2026-09-02T12:00:00Z' },
    lifecycle: { desired: 'ready', normalized: 'ready-without-setup-proof', providerRawState: 'Running', lastObservedAt: '2026-09-02T12:00:00.000Z', activeOperation: null },
    recovery: null,
    cleanup: { remoteStopped: false, remoteDeleted: false, tombstoneWritten: false },
  };
}

export function decodedRemoteSshArgv(args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  if (separator < 0) throw new Error('SSH fixture argv is missing its separator.');
  const remote = args.slice(separator + 1);
  if (remote.length !== 1) throw new Error('SSH fixture argv must contain exactly one encoded remote command.');
  const encoded = remote[0];
  if (!encoded) throw new Error('SSH fixture encoded remote command is empty.');
  const values: string[] = [];
  let index = 0;
  while (index < encoded.length) {
    if (encoded[index] !== "'") throw new Error(`SSH fixture command is not POSIX-quoted: ${encoded}`);
    index += 1;
    let value = '';
    let terminated = false;
    while (index < encoded.length) {
      if (encoded.startsWith("'\"'\"'", index)) { value += "'"; index += 5; continue; }
      if (encoded[index] === "'") { index += 1; terminated = true; break; }
      value += encoded[index] ?? '';
      index += 1;
    }
    if (!terminated) throw new Error(`SSH fixture command has an unterminated quote: ${encoded}`);
    values.push(value);
    if (index === encoded.length) break;
    if (encoded[index] !== ' ') throw new Error(`SSH fixture command has an invalid separator: ${encoded}`);
    index += 1;
    if (index === encoded.length) throw new Error(`SSH fixture command has a trailing separator: ${encoded}`);
  }
  return values;
}

/** Provider runner that serves every fixed helper bootstrap probe for a fixture root. */
export function helperBootstrapRunner(overrides: { uname?: string; sha256For?: (path: string) => string; statFor?: (path: string) => string; handshake?: string } = {}): CodespacesProviderProcess {
  const x64Digest = digest(FIXTURE_X64);
  return {
    async run(command, args, runOptions) {
      assert.equal(command, 'gh');
      if (!args.join(' ').startsWith(`codespace ssh -c ${REMOTE_NAME} -- `)) throw new Error(`unrouted bootstrap argv: ${JSON.stringify(args)}`);
      const remote = decodedRemoteSshArgv(args);
      const argv = remote.join(' ');
      if (argv === 'uname -m') return { code: 0, stdout: `${overrides.uname ?? 'x86_64'}\n`, stderr: '' };
      if (argv === 'id -u') return { code: 0, stdout: '1000\n', stderr: '' };
      if (argv.startsWith('mkdir -p')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('chmod 0700 ')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('mv ')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('tee ')) {
        assert.ok(runOptions?.binaryInput !== undefined, 'copy must stream package-owned bytes');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv.startsWith('sha256sum ')) {
        const path = argv.split(' ')[1];
        const value = overrides.sha256For ? overrides.sha256For(path) : x64Digest;
        return { code: 0, stdout: `${value}  ${path}\n`, stderr: '' };
      }
      if (argv.startsWith('stat -c %F|%a|%u|%g ')) {
        const path = argv.split(' ').at(-1) as string;
        return { code: 0, stdout: `${overrides.statFor ? overrides.statFor(path) : 'regular file|700|1000|1000'}\n`, stderr: '' };
      }
      if (argv.endsWith(' handshake')) {
        return { code: 0, stdout: `${overrides.handshake ?? `agent-containers-helper v0.1.0 protocol=${HELPER_PROTOCOL_VERSION} arch=x86_64 boot=${BOOT_ID}`}\n`, stderr: '' };
      }
      throw new Error(`unrouted bootstrap remote argv: ${argv}`);
    },
  };
}

export interface TransportFixture {
  stateDir: string;
  metadata: CodespacesWorkspaceMetadata;
  deps: RemoteTransportDependencies;
  helper: MockRemoteHelper;
  fixture: HelperFixtureRoot;
  dispatches: string[][];
  spawnerCalls: string[][];
  runner: CodespacesProviderProcess;
  now: () => string;
}

let tick = 0;
export function fixedNow(): () => string {
  return () => new Date(Date.UTC(2026, 8, 2, 12, 0, 0) + ++tick * 1000).toISOString();
}

export async function transportFixture(options: {
  helper?: MockRemoteHelper;
  runner?: CodespacesProviderProcess;
  spawner?: SshSpawner;
  config?: CodespacesAgentContainersConfig;
  signal?: AbortSignal;
  detachSignal?: AbortSignal;
  reconnectBudgetMs?: number;
  cancelGraceMs?: number;
  metadata?: CodespacesWorkspaceMetadata;
} = {}): Promise<TransportFixture> {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'agent-containers-transport-state-')), 'state');
  const metadata = options.metadata ?? recordedWorkspace();
  await saveMetadata(stateDir, metadata, { expectedGeneration: null });
  const intentCreatedAt = '2026-09-02T12:00:00.000Z';
  await recordCreateIntent(stateDir, {
    schemaVersion: 1, requestId: randomUUID(), name: WORKSPACE_NAME, createdAt: intentCreatedAt,
    control: metadata.control, repository: metadata.repository,
    source: metadata.source,
    capacity: { machine: metadata.remote.machine, geo: metadata.remote.geo, idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, displayNameHint: null },
    state: 'identity-verified', providerCorrelationId: null, providerError: null, providerResource: null, updatedAt: intentCreatedAt, recoveryContext: null,
  }, { expectAbsent: true });
  const fixture = await createHelperFixtureRoot();
  const runner = options.runner ?? helperBootstrapRunner();
  const dispatches: string[][] = [];
  const wrappingRunner: CodespacesProviderProcess = {
    async run(command, args, runOptions) {
      dispatches.push(args);
      return runner.run(command, args, runOptions);
    },
  };
  const config = options.config ?? transportConfigFixture();
  const helper = options.helper ?? new MockRemoteHelper();
  const now = fixedNow();
  const spawnerCalls: string[][] = [];
  const spawner = options.spawner ?? createMockSshSpawner(helper, (call) => spawnerCalls.push([...call.argv]));
  const deps: RemoteTransportDependencies = {
    stateDir, metadata, provider: new GhCodespacesProvider(wrappingRunner), root: fixture.root, config,
    spawner: spawner as SshSpawner,
    signal: options.signal, detachSignal: options.detachSignal, now,
    reconnectBudgetMs: options.reconnectBudgetMs, cancelGraceMs: options.cancelGraceMs,
    logger: async (input) => { await recordCodespacesEvent(stateDir, input); },
  };
  return { stateDir, metadata, deps, helper, fixture, dispatches, spawnerCalls, runner: wrappingRunner, now };
}

export function encodeAll(events: Array<{ stream: 'stdout' | 'stderr' | 'terminal'; offset: bigint; bytes: Uint8Array }>): { stdout: Buffer; stderr: Buffer; terminal: Buffer } {
  const out = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), terminal: Buffer.alloc(0) };
  for (const event of events) out[event.stream] = Buffer.concat([out[event.stream], Buffer.from(event.bytes)]);
  return out;
}

export function assertReassembled(events: Array<{ stream: 'stdout' | 'stderr'; offset: bigint; bytes: Uint8Array }>, expected: Record<'stdout' | 'stderr', Buffer>): void {
  assert.deepEqual(encodeAll(events as Array<{ stream: 'stdout' | 'stderr'; offset: bigint; bytes: Uint8Array }>).stdout, expected.stdout);
}

export async function collect<T>(generator: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) values.push(value);
  return values;
}

export async function drain(generator: AsyncIterable<unknown>): Promise<void> {
  for await (const value of generator) void value;
}

export type { WorkspaceMetadata };
