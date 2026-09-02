import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProductionStateDurabilityAdapter, type StateDurabilityAdapter } from './durability.js';
import { HELPER_PROTOCOL_VERSION } from './codespaces-protocol.js';
import type { GhCodespacesProvider } from './codespaces.js';
import { isValidWorkspaceName } from './names.js';
import { secretShaped } from './secrets.js';

/**
 * Remote controlled-execution helper packaging and bootstrap (Story 2.1).
 *
 * The package owns exactly two architecture-pinned static artifacts
 * (linux-x64 and linux-arm64) recorded in a checksummed manifest committed in
 * the repository. Bootstrap copies only the matching package-owned artifact
 * through controlled `gh codespace ssh` argv and verifies digest, owner, mode,
 * regular-file type, exact helper path, and protocol handshake before any
 * execution. Any mismatch fails closed; there is never a fallback download
 * from an arbitrary URL.
 */
export const HELPER_MANIFEST_SCHEMA_VERSION = 1;
const HELPER_REMOTE_STATE_DIR = '/workspaces/.agent-containers';

export interface HelperManifestArchitecture {
  file: string;
  /** Pinned SHA-256 of the staged artifact; null until the packaged build stages it. */
  sha256: string | null;
  /** Pinned byte size; null until the packaged build stages it. */
  size: number | null;
  /** Committed artifact mode, e.g. '0755'. */
  mode: string;
}

export interface HelperManifest {
  schemaVersion: 1;
  protocol: number;
  helperVersion: string;
  /** True once the pinned helper-artifacts build staged the static binaries. */
  artifactsStaged: boolean;
  architectures: Record<'linux-x64' | 'linux-arm64', HelperManifestArchitecture>;
  sourcePins: { 'helper.c': string; Makefile: string };
  selfChecksum: string;
  generatedAt: string;
}

/** A staged architecture entry whose pin is always present. */
export type StagedHelperManifestArchitecture = HelperManifestArchitecture & { sha256: string; size: number };

export interface HelperArtifact {
  arch: 'linux-x64' | 'linux-arm64';
  entry: StagedHelperManifestArchitecture;
  bytes: Uint8Array;
}

export interface LocalHelperBootstrapRecord {
  schemaVersion: 1;
  workspaceName: string;
  workspaceId: string;
  arch: 'linux-x64' | 'linux-arm64';
  file: string;
  binPath: string;
  sha256: string;
  protocolVersion: number;
  helperVersion: string;
  remoteBootId: string;
  recordedAt: string;
}

export interface RemoteHelperBootstrapDependencies {
  stateDir: string;
  workspaceName: string;
  workspaceId: string;
  /** The exact recorded Codespaces provider name used in every SSH argv. */
  remoteName: string;
  provider: GhCodespacesProvider;
  /** Package root containing native/helper/manifest.json and bin artifacts. */
  root: string;
  sshTimeoutMs?: number;
  /** Cancels controlled remote helper bootstrap/inspection probes. */
  signal?: AbortSignal;
  now?: () => string;
  /** When a matching helper bootstrap record exists, verify instead of copying. */
  verifyKnown?: boolean;
}

let testDurabilityAdapter: StateDurabilityAdapter | undefined;
export function setCodespacesHelperDurabilityAdapterForTesting(adapter: StateDurabilityAdapter | undefined): void {
  testDurabilityAdapter = adapter;
}
function durability(): StateDurabilityAdapter {
  return testDurabilityAdapter ?? getProductionStateDurabilityAdapter();
}

export function helperRoot(moduleUrl: string = import.meta.url): string {
  return resolve(fileURLToPath(new URL('../../', moduleUrl)));
}

export function helperManifestPath(root: string): string {
  return join(root, 'native', 'helper', 'manifest.json');
}

export function helperBinDir(root: string): string {
  return join(root, 'native', 'helper', 'bin');
}

export function localHelperBootstrapPath(stateDir: string, workspaceName: string): string {
  if (!isValidWorkspaceName(workspaceName)) throw new Error('Workspace name is invalid.');
  return join(stateDir, 'codespaces', 'helper', `${workspaceName}.json`);
}

/** Map a fixed remote `uname -m` probe to a package-owned artifact; unknown archs fail closed. */
export function helperArchForUname(uname: string): 'linux-x64' | 'linux-arm64' | undefined {
  const value = uname.trim();
  if (value === 'x86_64' || value === 'amd64') return 'linux-x64';
  if (value === 'aarch64' || value === 'arm64') return 'linux-arm64';
  return undefined;
}

export async function loadHelperManifest(root: string): Promise<HelperManifest> {
  let source: string;
  try {
    source = await readFile(helperManifestPath(root), 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) throw new Error('The package-owned helper manifest is absent; helper bootstrap is unavailable.', { cause: error });
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('The package-owned helper manifest is not valid JSON; refusing to trust helper artitecture pins.');
  }
  if (!isHelperManifest(value)) throw new Error('The package-owned helper manifest is corrupt; refusing to trust helper architecture pins.');
  if (value.selfChecksum !== manifestSelfChecksum(value)) throw new Error('The package-owned helper manifest fails its own checksum; refusing to trust helper pins.');
  return value;
}

function manifestSelfChecksum(manifest: Omit<HelperManifest, 'selfChecksum'>): string {
  return createHash('sha256').update(JSON.stringify({ ...manifest, selfChecksum: undefined })).digest('hex');
}

export function isHelperManifest(value: unknown): value is HelperManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Partial<HelperManifest>;
  if (manifest.schemaVersion !== 1 || !Number.isInteger(manifest.protocol) || manifest.protocol !== HELPER_PROTOCOL_VERSION
    || !safeDisplay(manifest.helperVersion) || !isTimestamp(manifest.generatedAt)
    || typeof manifest.artifactsStaged !== 'boolean'
    || typeof manifest.selfChecksum !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.selfChecksum)
    || typeof manifest.sourcePins !== 'object' || manifest.sourcePins === null
    || !/^[0-9a-f]{64}$/.test(manifest.sourcePins['helper.c'] ?? '') || !/^[0-9a-f]{64}$/.test(manifest.sourcePins.Makefile ?? '')) return false;
  const entries = manifest.architectures;
  if (typeof entries !== 'object' || entries === null || !entries['linux-x64'] || !entries['linux-arm64']) return false;
  for (const arch of ['linux-x64', 'linux-arm64'] as const) {
    if (!isArchitectureEntry(entries[arch], manifest.artifactsStaged)) return false;
  }
  return true;
}

function isArchitectureEntry(value: unknown, staged: boolean): value is HelperManifestArchitecture {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<HelperManifestArchitecture>;
  return typeof entry.file === 'string' && /^agent-containers-helper-linux-(x64|arm64)$/.test(entry.file)
    && (staged
      ? (typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256) && typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size > 0)
      : entry.sha256 === null && entry.size === null)
    && typeof entry.mode === 'string' && /^[0-7]{4}$/.test(entry.mode);
}

/** Load the exact package-owned artifact for the selected architectures. */
export async function loadHelperArtifact(root: string, arch: 'linux-x64' | 'linux-arm64'): Promise<HelperArtifact> {
  const manifest = await loadHelperManifest(root);
  if (!manifest.artifactsStaged) {
    throw new Error(`The package-owned helper artifact for ${arch} is not staged in this package; build and pin the static helper artifacts (make + cross toolchain) before execution. No arbitrary download fallback exists.`);
  }
  const entry = manifest.architectures[arch];
  const pinned = entry.sha256;
  const expectedSize = entry.size;
  if (pinned === null || expectedSize === null) throw new Error(`The package-owned helper artifact ${entry.file} is unstaged; refusing a fabricated or fallback artifact.`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(helperBinDir(root), entry.file)));
  } catch (error: unknown) {
    throw new Error(`The package-owned helper artifact ${entry.file} is absent; helper bootstrap refuses to fall back to an arbitrary download.`, { cause: error });
  }
if (bytes.length !== expectedSize) throw new Error(`The package-owned helper artifact ${entry.file} has wrong size; refusing the tampered artifact.`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pinned) throw new Error(`The package-owned helper artifact ${entry.file} fails its pinned SHA-256 digest; refusing the tampered artifact.`);
  const stagedEntry: StagedHelperManifestArchitecture = { file: entry.file, sha256: pinned, size: expectedSize, mode: entry.mode };
  return { arch, entry: stagedEntry, bytes };
}

/** Fixed remote path; both are assembled only from validated constant/UUID components. */
export function helperRemoteBinDir(workspaceId: string): string {
  if (!isValidWorkspaceId(workspaceId)) throw new Error('Workspace identity for the remote helper path is invalid.');
  return `${HELPER_REMOTE_STATE_DIR}/${workspaceId}/bin`;
}

export function helperRemotePath(workspaceId: string, file: string): string {
  return `${helperRemoteBinDir(workspaceId)}/${validatedHelperFile(file)}`;
}

export async function recordLocalHelperBootstrap(stateDir: string, record: LocalHelperBootstrapRecord): Promise<void> {
  if (!isLocalHelperBootstrapRecord(record)) throw new Error('Refusing to record an invalid remote helper bootstrap record.');
  const adapter = durability();
  await adapter.assertStateWriteSupport();
  const directory = dirname(localHelperBootstrapPath(stateDir, record.workspaceName));
  await ensureDurableDirectory(directory, adapter);
  const path = localHelperBootstrapPath(stateDir, record.workspaceName);
  await durableWrite(path, directory, `${JSON.stringify(record, null, 2)}\n`, adapter);
}

export async function loadLocalHelperBootstrap(stateDir: string, workspaceName: string): Promise<LocalHelperBootstrapRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(localHelperBootstrapPath(stateDir, workspaceName), 'utf8'));
    if (!isLocalHelperBootstrapRecord(value)) throw new Error(`Helper bootstrap record for ${workspaceName} is corrupt; refusing to trust stale helper facts.`);
    return value;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export interface RemoteHelperBootstrapResult {
  arch: 'linux-x64' | 'linux-arm64';
  file: string;
  binPath: string;
  sha256: string;
  protocolVersion: number;
  helperVersion: string;
  remoteBootId: string;
  recordedAt: string;
}

/**
 * Bootstrap sequence (Story 2.1): probe remote architecture with a fixed
 * command, copy only the package-owned artifact through controlled `gh
 * codespace ssh` argv, verify digest/owner/mode/type/exact path, perform the
 * protocol handshake, and record the remote boot ID. Every step fails closed;
 * mismatch on any of architecture/digest/owner/mode/protocol/path blocks.
 */
export async function bootstrapRemoteHelper(deps: RemoteHelperBootstrapDependencies): Promise<RemoteHelperBootstrapResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const known = await loadLocalHelperBootstrap(deps.stateDir, deps.workspaceName);
  if (deps.verifyKnown && known) {
    const artifact = await loadHelperArtifact(deps.root, known.arch);
    const expectedPath = helperRemotePath(deps.workspaceId, artifact.entry.file);
    if (known.workspaceName !== deps.workspaceName || known.workspaceId !== deps.workspaceId
      || known.file !== artifact.entry.file || known.binPath !== expectedPath
      || known.sha256 !== artifact.entry.sha256 || known.protocolVersion !== HELPER_PROTOCOL_VERSION) {
      throw helperBootstrapError('The persisted helper record does not match the current workspace identity and pinned package artifact; refusing execution.');
    }
    // Return only the canonical, freshly inspected execution result. Persisted
    // fields are an untrusted cache and must never select a remote executable.
    return inspectRemoteHelper(deps, known.arch, artifact.entry.file);
  }
  const uname = await probeUname(deps);
  const arch = helperArchForUname(uname);
  if (!arch) throw helperBootstrapError(`Remote architecture ${redact(uname)} has no package-owned helper artifact; execution is unsupported and never falls back.`);
  const artifact = await loadHelperArtifact(deps.root, arch);
  const binDir = helperRemoteBinDir(deps.workspaceId);
  const tmpPath = `${binDir}/${artifact.entry.file}.tmp.${randomUUID().slice(0, 8)}`;
  const finalPath = helperRemotePath(deps.workspaceId, artifact.entry.file);

  await runFixed(deps, ['mkdir', '-p', binDir]);
  await runFixed(deps, ['tee', tmpPath], { input: artifact.bytes });
  /* The verifier demands owner-only 0700; the stream write above lands as 0666,
   * so the mode check must observe the POST-chmod stat (B1). */
  await runFixed(deps, ['chmod', '0700', tmpPath]);
  await verifyFileOnRemote(deps, tmpPath, artifact);
  await runFixed(deps, ['mv', tmpPath, finalPath]);
  await verifyFileOnRemote(deps, finalPath, artifact);
  const handshake = await handshakeRemoteHelper(deps, finalPath, arch);
  const result: RemoteHelperBootstrapResult = {
    arch,
    file: artifact.entry.file,
    binPath: finalPath,
    sha256: artifact.entry.sha256,
    protocolVersion: handshake.protocol,
    helperVersion: handshake.helperVersion,
    remoteBootId: handshake.remoteBootId,
    recordedAt: now(),
  };
  await recordLocalHelperBootstrap(deps.stateDir, {
    schemaVersion: 1,
    workspaceName: deps.workspaceName,
    workspaceId: deps.workspaceId,
    arch,
    file: artifact.entry.file,
    binPath: finalPath,
    sha256: artifact.entry.sha256,
    protocolVersion: handshake.protocol,
    helperVersion: handshake.helperVersion,
    remoteBootId: handshake.remoteBootId,
    recordedAt: result.recordedAt,
  });
  return result;
}

/**
 * Read-only helper inspection against an exact recorded Codespace: checks the
 * pinned digest, owner/mode/type, exact helper path, and protocol handshake
 * without copying anything. Used by doctor and by pre-execution re-entry.
 */
export async function inspectRemoteHelper(deps: RemoteHelperBootstrapDependencies, arch: 'linux-x64' | 'linux-arm64', file: string): Promise<RemoteHelperBootstrapResult> {
  const artifact = await loadHelperArtifact(deps.root, arch);
  if (file !== artifact.entry.file) throw helperBootstrapError('The recorded helper file does not match the package-owned artifact path; refusing execution.');
  const finalPath = helperRemotePath(deps.workspaceId, file);
  await verifyFileOnRemote(deps, finalPath, artifact);
  const handshake = await handshakeRemoteHelper(deps, finalPath, arch);
  return { arch, file, binPath: finalPath, sha256: artifact.entry.sha256, protocolVersion: handshake.protocol, helperVersion: handshake.helperVersion, remoteBootId: handshake.remoteBootId, recordedAt: deps.now?.() ?? new Date().toISOString() };
}

async function probeUname(deps: RemoteHelperBootstrapDependencies): Promise<string> {
  const output = await deps.provider.remoteSshProbe(deps.remoteName, ['uname', '-m'], { timeoutMs: deps.sshTimeoutMs, signal: deps.signal });
  return output.trim();
}

async function runFixed(deps: RemoteHelperBootstrapDependencies, argv: readonly string[], options: { input?: Uint8Array } = {}): Promise<string> {
  return deps.provider.remoteCommand(deps.remoteName, argv as readonly string[], { timeoutMs: deps.sshTimeoutMs, input: options.input, signal: deps.signal });
}

async function verifyFileOnRemote(deps: RemoteHelperBootstrapDependencies, path: string, artifact: HelperArtifact): Promise<void> {
  const digestLine = (await runFixed(deps, ['sha256sum', path])).trim();
  const digest = digestLine.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(digest) || digest !== artifact.entry.sha256) {
    throw helperBootstrapError(`Remote helper digest mismatch on ${path}; execution is blocked.`);
  }
  const uid = (await runFixed(deps, ['id', '-u'])).trim();
  if (!/^[1-9][0-9]*$/.test(uid)) throw helperBootstrapError('Could not verify the remote helper owner; execution is blocked.');
  const statLine = (await runFixed(deps, ['stat', '-c', '%F|%a|%u|%g', path])).trim();
  const fields = statLine.split('|');
  const kind = fields[0];
  const mode = fields[1];
  const statUid = fields[2];
  const statGid = fields[3];
  if (kind !== 'regular file') throw helperBootstrapError(`Remote helper at ${path} is not a regular file; execution is blocked.`);
  if (mode !== '700') throw helperBootstrapError(`Remote helper mode ${mode} is not owner-only 0700; execution is blocked.`);
  if (statUid !== uid || statUid === '0') throw helperBootstrapError('Remote helper owner does not match the SSH user; execution is blocked.');
  if (statGid === '0') throw helperBootstrapError('Remote helper group is root-owned; execution is blocked.');
  void statGid;
}

export interface HelperHandshake { protocol: number; helperVersion: string; remoteBootId: string; arch: string }

async function handshakeRemoteHelper(deps: RemoteHelperBootstrapDependencies, path: string, arch: 'linux-x64' | 'linux-arm64'): Promise<HelperHandshake> {
  const output = (await runFixed(deps, [path, 'handshake'])).trim();
  const match = /^agent-containers-helper v([0-9]+\.[0-9]+\.[0-9]+) protocol=([0-9]+) arch=([A-Za-z0-9_-]+) boot=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(output);
  if (!match) throw helperBootstrapError('The remote helper protocol handshake did not match the package-owned format; execution is blocked.');
  const protocol = Number(match[2]);
  if (protocol !== HELPER_PROTOCOL_VERSION) throw helperBootstrapError(`Remote helper protocol ${protocol} does not match the pinned package protocol ${HELPER_PROTOCOL_VERSION}; execution is blocked.`);
  const expectedArch = arch === 'linux-x64' ? 'x86_64' : 'aarch64';
  if (match[3] !== expectedArch) throw helperBootstrapError(`Remote helper architecture ${match[3]} does not match the probed ${expectedArch}; execution is blocked.`);
  return { protocol, helperVersion: match[1], remoteBootId: match[4], arch: match[3] };
}

function helperBootstrapError(detail: string): Error {
  return new Error(`Remote helper is not safe to execute: ${detail}`);
}

function isLocalHelperBootstrapRecord(value: unknown): value is LocalHelperBootstrapRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<LocalHelperBootstrapRecord>;
  return record.schemaVersion === 1 && isValidWorkspaceName(record.workspaceName ?? '') && isValidWorkspaceId(record.workspaceId ?? '')
    && (record.arch === 'linux-x64' || record.arch === 'linux-arm64') && typeof record.file === 'string'
    && /^agent-containers-helper-linux-(x64|arm64)$/.test(record.file) && typeof record.binPath === 'string' && record.binPath.startsWith('/workspaces/.agent-containers/')
    && /^[0-9a-f]{64}$/.test(record.sha256 ?? '') && Number.isInteger(record.protocolVersion) && record.protocolVersion === HELPER_PROTOCOL_VERSION
    && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(record.helperVersion ?? '') && isUuid(record.remoteBootId) && isTimestamp(record.recordedAt);
}

function isValidWorkspaceId(value: string): boolean {
  return /^[0-9A-Za-z-]{1,128}$/.test(value);
}
function validatedHelperFile(value: string): string {
  if (!/^agent-containers-helper-linux-(x64|arm64)$/.test(value)) throw new Error('Helper artifact file is not package-owned.');
  return value;
}
function safeDisplay(value: unknown): value is string { return typeof value === 'string' && !secretShaped(value) && value.length > 0 && value.length <= 128 && !/[\0\r\n]/.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function redact(value: string): string { return value.replace(/[^\x20-\x7e]/g, '?').slice(0, 64); }
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }

async function ensureDurableDirectory(directory: string, adapter: StateDurabilityAdapter): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    let entry;
    try { entry = await lstat(current); }
    catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Unable to find a parent for durable directory: ${directory}`, { cause: error });
      missing.push(current);
      current = parent;
      continue;
    }
    if (!entry.isDirectory()) throw new Error(`Durable directory path is not a directory: ${current}`);
    break;
  }
  for (const created of missing.reverse()) {
    await mkdir(created, { recursive: false, mode: 0o700 });
    await adapter.syncDirectory(created);
    await adapter.syncDirectory(dirname(created));
  }
}

async function durableWrite(path: string, directory: string, content: string, adapter: StateDurabilityAdapter): Promise<void> {
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.close();
    file = undefined;
    await adapter.syncFile(temporary);
    if (await adapter.publicationMode() === 'recoverable') await adapter.moveFileWriteThrough(temporary, path);
    else { await rename(temporary, path); await adapter.syncDirectory(directory); }
  } catch (error: unknown) {
    await file?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}