import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CommandEvent, CodespacesAgentContainersConfig } from './types.js';
import {
  computeRequestHash, decodeFramedJson, encodeFrame, encodeJsonFrame, encodeOutputEvent, decodeOutputEvent,
  HelperFrameDecoder, HelperFrameType, HELPER_PROTOCOL_VERSION, type HelperFrame, type OutputStreamName,
} from './codespaces-protocol.js';
import type { GhCodespacesProvider } from './codespaces.js';
import { loadMetadata, metadataGeneration, saveMetadata, type CodespacesWorkspaceMetadata } from './state.js';
import {
  loadCommandOffsets, loadCommandRequest, loadCommandStatus, recordCommandRecovery, recordCommandRequest, resolveCommandIdempotency,
  saveCommandOffsets, saveCommandStatus, type CodespacesCommandOffsets, type CodespacesCommandStatus,
} from './codespaces-command.js';
import { bootstrapRemoteHelper, inspectRemoteHelper, type RemoteHelperBootstrapResult } from './codespaces-helper.js';
import type { CodespacesJournalEventInput } from './codespaces-ops.js';
import { redactSecretDiagnostic } from './secrets.js';

/**
 * Streaming transport over `gh codespace ssh`. The remote argv is always the
 * fixed package-owned helper path plus the `serve` subcommand (or fixed
 * bootstrap subcommands) assembled from validated constant/UUID components;
 * user argv travels only inside length-prefixed protocol frames on stdin,
 * never as remote command text.
 */
export interface FramedChildProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close' | 'error', listener: (...args: unknown[]) => void): this;
}

export type SshSpawner = (argv: readonly string[], options: { signal?: AbortSignal }) => FramedChildProcess;

/** Production spawner: `gh codespace ssh` with shell:false. */
export function createNodeSshSpawner(): SshSpawner {
  return (argv, options) => spawn('gh', [...argv], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, signal: options.signal }) as unknown as FramedChildProcess;
}

const MAX_PENDING_EVENTS = 128;
const MAX_PENDING_EVENT_BYTES = 4 * 1024 * 1024;
const OFFSET_PERSIST_THRESHOLD = 64 * 1024;
const MAX_STDIN_FRAME_BYTES = 64 * 1024;

async function forwardResizes(session: HelperSession, commandId: string, source: AsyncIterable<{ cols: number; rows: number }>): Promise<void> {
  try {
    for await (const size of source) {
      if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows) || size.cols < 1 || size.rows < 1 || size.cols > 8192 || size.rows > 8192) {
        throw new Error('A PTY resize event is outside the supported bounds; the resize frame is refused.');
      }
      await session.send(HelperFrameType.resize, { command_id: commandId, cols: size.cols, rows: size.rows });
    }
  } catch {
    // A resize source failure never changes command outcome; the PTY stream stays merged.
  }
}

export class TransportLostError extends Error {
  constructor(detail = 'The SSH transport for the remote helper was lost; the command may still be running remotely.') {
    super(detail);
    this.name = 'TransportLostError';
  }
}

export type RemoteHelperEvent =
  | { kind: 'hello-ok'; protocol: number; helperVersion: string; helperArch: string; remoteBootId: string; helperPid: number }
  | { kind: 'rejected'; commandId: string | null; reason: string }
  | { kind: 'started'; commandId: string; pid: number; startedAt: string; remoteBootId: string }
  | { kind: 'output'; commandId: string; stream: OutputStreamName; offset: bigint; bytes: Uint8Array }
  | { kind: 'status'; commandId: string; state: string; exitCode: number | null; stdoutOffset: bigint; stderrOffset: bigint; terminalOffset: bigint }
  | { kind: 'exit'; commandId: string; code: number | null; exitedAt: string }
  | { kind: 'cancel-verified'; commandId: string; cancelledAt: string }
  | { kind: 'cancel-unknown'; commandId: string; detail: string }
  | { kind: 'error'; commandId: string | null; message: string };

export function decodeHelperEvent(frame: HelperFrame): RemoteHelperEvent {
  switch (frame.type) {
    case HelperFrameType.helloOk: {
      const value = decodeFramedJson<{ protocol?: number; helper_version?: string; helper_arch?: string; remote_boot_id?: string; helper_pid?: number }>(frame);
      if (!Number.isInteger(value.protocol) || typeof value.helper_version !== 'string' || typeof value.helper_arch !== 'string'
        || typeof value.remote_boot_id !== 'string' || !Number.isInteger(value.helper_pid)) throw new Error('Helper hello-ok event is incomplete; refusing the unsafe handshake.');
      return { kind: 'hello-ok', protocol: value.protocol as number, helperVersion: value.helper_version, helperArch: value.helper_arch, remoteBootId: value.remote_boot_id, helperPid: value.helper_pid as number };
    }
    case HelperFrameType.rejected: {
      const value = decodeFramedJson<{ command_id?: unknown; reason?: unknown }>(frame);
      return { kind: 'rejected', commandId: typeof value.command_id === 'string' ? value.command_id : null, reason: typeof value.reason === 'string' ? value.reason : 'unspecified' };
    }
    case HelperFrameType.started: {
      const value = decodeFramedJson<{ command_id?: unknown; pid?: unknown; started_at?: unknown; remote_boot_id?: unknown }>(frame);
      if (typeof value.command_id !== 'string' || !Number.isInteger(value.pid) || typeof value.started_at !== 'string') throw new Error('Helper started event is incomplete.');
      return { kind: 'started', commandId: value.command_id, pid: value.pid as number, startedAt: value.started_at, remoteBootId: typeof value.remote_boot_id === 'string' ? value.remote_boot_id : '' };
    }
    case HelperFrameType.output: {
      const decoded = decodeOutputEvent(frame.payload);
      return { kind: 'output', commandId: '', stream: decoded.stream, offset: decoded.offset, bytes: decoded.bytes };
    }
    case HelperFrameType.status: {
      const value = decodeFramedJson<{ command_id?: unknown; state?: unknown; exit_code?: unknown }>(frame);
      return {
        kind: 'status', commandId: typeof value.command_id === 'string' ? value.command_id : '', state: typeof value.state === 'string' ? value.state : '',
        exitCode: typeof value.exit_code === 'number' ? value.exit_code : null, stdoutOffset: 0n, stderrOffset: 0n, terminalOffset: 0n,
      };
    }
    case HelperFrameType.exit: {
      const value = decodeFramedJson<{ command_id?: unknown; code?: unknown; exited_at?: unknown }>(frame);
      if (typeof value.command_id !== 'string' || typeof value.exited_at !== 'string') throw new Error('Helper exit event is incomplete; refusing an unproven exit status.');
      return { kind: 'exit', commandId: value.command_id, code: typeof value.code === 'number' ? value.code : null, exitedAt: value.exited_at };
    }
    case HelperFrameType.cancelVerified: {
      const value = decodeFramedJson<{ command_id?: unknown; cancelled_at?: unknown }>(frame);
      if (typeof value.command_id !== 'string' || typeof value.cancelled_at !== 'string') throw new Error('Helper cancel-verified event is incomplete; cancellation cannot be claimed.');
      return { kind: 'cancel-verified', commandId: value.command_id, cancelledAt: value.cancelled_at };
    }
    case HelperFrameType.cancelUnknown: {
      const value = decodeFramedJson<{ command_id?: unknown; message?: unknown }>(frame);
      return { kind: 'cancel-unknown', commandId: typeof value.command_id === 'string' ? value.command_id : '', detail: typeof value.message === 'string' ? value.message : 'cancellation could not be proven remotely' };
    }
    case HelperFrameType.error: {
      const value = decodeFramedJson<{ command_id?: unknown; message?: unknown }>(frame);
      return { kind: 'error', commandId: typeof value.command_id === 'string' ? value.command_id : null, message: typeof value.message === 'string' ? value.message : 'unspecified helper error' };
    }
    default:
      throw new Error(`Helper emitted an unknown frame type ${frame.type}; refusing to interpret the stream.`);
  }
}

/**
 * One framed connection to the remote helper. Reads are pulled (bounded
 * inbound memory); writes await the pipe drain (bounded outbound backpressure).
 */
export class HelperSession {
  private readonly decoder = new HelperFrameDecoder();
  private readonly queue: HelperFrame[] = [];
  private readonly waiters: Array<(frame: HelperFrame | null) => void> = [];
  private pendingBytes = 0;
  private failure: Error | null = null;
  private ended = false;
  private writeBacklog: Promise<void> = Promise.resolve();

  constructor(private readonly child: FramedChildProcess) {
    child.stdout.on('data', (chunk: string | Uint8Array) => {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      let frames: HelperFrame[];
      try {
        frames = this.decoder.push(bytes);
      } catch (error: unknown) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const frame of frames) this.enqueue(frame);
    });
    child.stdout.on('error', (error: Error) => this.fail(error));
    child.stdout.on('end', () => {
      try {
        for (const frame of this.decoder.flush()) this.enqueue(frame);
      } catch (error: unknown) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.end();
    });
    child.stdout.on('close', () => this.end());
  }

  private enqueue(frame: HelperFrame): void {
    if (this.waiters.length > 0) {
      const deliver = this.waiters.shift() as (frame: HelperFrame | null) => void;
      deliver(frame);
      return;
    }
    this.queue.push(frame);
    this.pendingBytes += frame.payload.length;
    if (this.queue.length >= MAX_PENDING_EVENTS || this.pendingBytes >= MAX_PENDING_EVENT_BYTES) {
      this.child.stdout.pause();
    }
  }

  async nextFrame(): Promise<HelperFrame | null> {
    while (true) {
      if (this.queue.length > 0) {
        const frame = this.queue.shift() as HelperFrame;
        this.pendingBytes = Math.max(0, this.pendingBytes - frame.payload.length);
        if (this.queue.length < MAX_PENDING_EVENTS / 2) this.child.stdout.resume();
        return frame;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return null;
      }
      let delivered: HelperFrame | null = null;
      await new Promise<void>((resolve) => {
        this.waiters.push((frame) => { delivered = frame; resolve(); });
      });
      if (delivered !== null) return delivered;
      if (this.ended) { if (this.failure) throw this.failure; return null; }
    }
  }

  async nextEvent(): Promise<RemoteHelperEvent | null> {
    const frame = await this.nextFrame();
    return frame === null ? null : decodeHelperEvent(frame);
  }

  /** Write a JSON or binary frame with bounded backpressure. */
  async send(type: number, payload: Uint8Array | Record<string, unknown>): Promise<void> {
    const bytes = payload instanceof Uint8Array ? encodeFrame(type, payload) : encodeJsonFrame(type, payload);
    await this.write(bytes);
  }

  async sendOutput(stream: number, offset: bigint, bytes: Uint8Array): Promise<void> {
    await this.write(encodeFrame(HelperFrameType.output, encodeOutputEvent(stream, offset, bytes)));
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (this.ended) throw new TransportLostError('Cannot write to a closed helper session.');
    const previous = this.writeBacklog;
    let release!: () => void;
    this.writeBacklog = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!this.child.stdin.write(bytes)) await new Promise<void>((resolve) => this.child.stdin.once('drain', resolve));
    } catch {
      throw new TransportLostError('The remote helper stdin was closed; the transport is unusable.');
    } finally {
      release();
    }
  }

  endStdin(): void {
    try { this.child.stdin.end(); } catch { /* already closed */ }
  }

  close(): void {
    try { this.child.kill(); } catch { /* best effort */ }
  }

  private fail(error: Error): void {
    if (this.failure || this.ended) return;
    this.failure = error;
    this.end();
  }

private end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) (this.waiters.shift() as (frame: HelperFrame | null) => void)(null);
  }
}

export interface RemoteTransportDependencies {
  stateDir: string;
  metadata: CodespacesWorkspaceMetadata;
  provider: GhCodespacesProvider;
  root: string;
  config: CodespacesAgentContainersConfig;
  spawner: SshSpawner;
  signal?: AbortSignal;
  /** Second-interrupt channel: while a cancel proof is pending, aborting detaches and records unknown outcome. */
  detachSignal?: AbortSignal;
  now?: () => string;
  logger?: (input: CodespacesJournalEventInput) => Promise<void>;
  sshTimeoutMs?: number;
  reconnectBudgetMs?: number;
  cancelGraceMs?: number;
}

export interface ExecuteTransportInput {
  commandId: string;
  argv: readonly [string, ...string[]];
  mode: 'pipe' | 'pty';
  cwd?: string;
  stdin: 'closed' | 'stream';
  cols?: number;
  rows?: number;
  /** Inbound user stdin forwarded as stdin frames and half-closed once exhausted. */
  stdinSource?: AsyncIterable<Uint8Array>;
  /** PTY resize events forwarded to the remote helper. */
  resizeSource?: AsyncIterable<{ cols: number; rows: number }>;
}

function statusRecord(commandId: string, now: () => string, state: CodespacesCommandStatus['state'], base?: CodespacesCommandStatus): CodespacesCommandStatus {
  const current = base ?? { schemaVersion: 1 as const, commandId, state: 'accepted' as const, exitCode: null, transport: 'connected' as const, createdAt: now(), startedAt: null, exitedAt: null, updatedAt: now() };
  const startedAt = state === 'running' && !current.startedAt ? now() : current.startedAt;
  const exitedAt = state === 'exited' || state === 'cancelled' || state === 'detached' || state === 'cancel-outcome-unknown' || state === 'outcome-unknown' ? current.exitedAt ?? now() : null;
  return { ...current, state, transport: 'connected', startedAt, exitedAt, updatedAt: now() };
}

export async function* executeRemoteCommand(deps: RemoteTransportDependencies, input: ExecuteTransportInput): AsyncGenerator<CommandEvent> {
  const now = deps.now ?? (() => new Date().toISOString());
  const commandId = input.commandId;
  const requestHash = computeRequestHash(input.argv, input.cwd, input.mode);
  const idempotency = await resolveCommandIdempotency(deps.stateDir, commandId, requestHash);
  if (idempotency === 'attach') {
    yield { type: 'accepted', commandId };
    yield* attachRemoteCommand(deps, commandId);
    return;
  }
  await recordCommandRequest(deps.stateDir, {
    schemaVersion: 1, commandId, requestHash, workspaceName: deps.metadata.name, workspaceId: deps.metadata.workspaceId,
    argvCount: input.argv.length, mode: input.mode, cwd: input.cwd ?? null, createdAt: now(),
  }, { expectAbsent: true });
  await journal(deps.logger, deps.metadata, { event: 'command-accepted', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: null, next: 'accepted', detail: null });
  yield { type: 'accepted', commandId };

  let savedStatus = (await loadCommandStatus(deps.stateDir, commandId)) ?? statusRecord(commandId, now, 'accepted');
  savedStatus = await saveStatus(deps, savedStatus);

  /* Register the abort listener BEFORE any async I/O so a first interrupt is
   * never missed in a busy event loop; cancel proof then routes through the
   * recorded owning process group (B3). */
  let cancelRequested = false;
  let session: HelperSession | undefined;
  const onAbort = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void journal(deps.logger, deps.metadata, { event: 'cancel-requested', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: 'running', next: 'cancelling', detail: null });
    session?.close();
  };
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  /* N7: an already-aborted signal never dispatches its listener, so a first
   * interrupt that raced the generator start must still cancel deterministically. */
  if (deps.signal?.aborted) cancelRequested = true;

  let offsets: CodespacesCommandOffsets;
  try {
    // bootstrapRemoteHelper verifies both fresh and known helpers. Keep every
    // following await within this try/finally so the first-interrupt listener
    // never survives a bootstrap, inspection, or durable-offset failure.
    const helper = await bootstrapRemoteHelper(helperDeps(deps));
    offsets = (await loadCommandOffsets(deps.stateDir, commandId)) ?? await zeroOffsets(deps, commandId, now);
    const transportBudget = deps.reconnectBudgetMs ?? deps.config.backends.codespaces.transport.reconnectWindowSeconds * 1000;
    const deadline = Date.now() + transportBudget;
    let attempt = 0;
    let attachNext = false;
    while (true) {
      if (cancelRequested) {
        const proof = await requestRemoteCancelProof(deps, commandId, requestHash, now);
        if (proof === 'verified') {
          await saveStatus(deps, statusRecord(commandId, now, 'cancelled', await loadCommandStatus(deps.stateDir, commandId) ?? savedStatus));
          await saveOffsets(deps, offsets, now);
          await journal(deps.logger, deps.metadata, { event: 'cancel-verified', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: 'cancelling', next: 'cancelled', detail: null });
          yield { type: 'cancelled', commandId };
        } else {
          await recordUnknownOutcome(deps, commandId, requestHash, offsets, now, savedStatus, 'cancel-outcome-unknown');
          yield { type: 'cancel-unknown', commandId };
        }
        return;
      }
      if (attempt >= 1 && Date.now() >= deadline) break;
      attempt += 1;
      const connect = attachNext ? openAttachSession : openExecSession;
      try {
        const opened = await connect(deps, helper, commandId, requestHash, input, offsets, now);
        attachNext = true;
        if (opened.kind === 'aborted') {
          throw new TransportLostError('The remote helper session was aborted before its handshake settled.');
        }
        if (opened.kind === 'rejected') {
          await saveStatus(deps, statusRecord(commandId, now, 'detached', await loadCommandStatus(deps.stateDir, commandId) ?? savedStatus));
          yield { type: 'rejected', commandId, reason: opened.reason as string };
          return;
        }
        const openedSession = opened.session as HelperSession;
        session = openedSession;
        // An abort can race openExecSession before `session` was assigned. Do
        // not stream a late-opened session; return to the loop-top proof gate.
        if (cancelRequested) { session.close(); session = undefined; continue; }
        yield { type: 'started', commandId };
        if (input.stdin === 'stream' && input.stdinSource) {
          for await (const chunk of input.stdinSource) {
            if (deps.signal?.aborted) { void session.close(); break; }
            if (chunk.length > MAX_STDIN_FRAME_BYTES) throw new Error('A user stdin chunk exceeded the bounded frame size; refusing the oversized chunk.');
            await session.send(HelperFrameType.stdin, chunk);
          }
        }
        /* Half-close stdin with an explicit protocol frame so the child keeps
         * running detached from the stream (spec 9.4). This is never a transport
         * half-close of the connection itself (B4). If the remote helper already
         * closed the transport, the queued output is still drained below and
         * the loss is handled by the reconnect loop, not by discarding bytes. */
        try {
          await session.send(HelperFrameType.stdinEof, { command_id: commandId, request_hash: requestHash });
        } catch (error: unknown) {
          if (!(error instanceof TransportLostError)) throw error;
        }
        if (input.mode === 'pty' && input.resizeSource) {
          void forwardResizes(session, commandId, input.resizeSource);
        }
        const streaming = yield* streamSession(deps, now, commandId, requestHash, session, offsets);
        session = undefined;
        offsets = streaming.offsets;
        await saveOffsets(deps, offsets, now);
        if (streaming.outcome === 'exited') {
          await journal(deps.logger, deps.metadata, { event: 'command-terminal', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: 'running', next: `exited(${streaming.exitCode ?? 'null'})`, detail: null });
          yield { type: 'exit', commandId, code: streaming.exitCode };
          return;
        }
        if (streaming.outcome === 'cancelled') {
          yield { type: 'cancelled', commandId };
          return;
        }
        if (streaming.outcome === 'rejected') {
          yield { type: 'rejected', commandId, reason: streaming.reason ?? 'rejected' };
          return;
        }
        // A stream ended without a terminal outcome (normal session close) -> reconnect.
      } catch (error: unknown) {
        if (session) { try { session.close(); } catch { /* closed */ } }
        session = undefined;
        const persisted = await loadCommandOffsets(deps.stateDir, commandId);
        if (persisted) offsets = persisted;
        if (cancelRequested) continue;
        if (!(error instanceof TransportLostError)) throw error;
      }
      if (cancelRequested) continue;
    }
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
  }

  await saveOffsets(deps, offsets, now);
  await saveStatus(deps, statusRecord(commandId, now, 'detached', await loadCommandStatus(deps.stateDir, commandId) ?? savedStatus));
  await journal(deps.logger, deps.metadata, { event: 'command-detached', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: 'running', next: 'detached', detail: 'reconnect budget exhausted; the remote command may still be running.' });
  await recordCommandRecovery(deps.stateDir, { commandId, workspaceName: deps.metadata.name, reason: 'transport-lost' });
  await setMetadataRecovery(deps, 'remote-exec-interrupted');
  yield { type: 'detached', commandId, offsets: offsetsBigint(offsets) };
}

export async function* attachRemoteCommand(deps: RemoteTransportDependencies, commandId: string): AsyncGenerator<CommandEvent> {
  const now = deps.now ?? (() => new Date().toISOString());
  const request = await loadCommandRequest(deps.stateDir, commandId);
  if (!request) throw new Error(`No recorded remote command "${commandId}" exists to attach to.`);
  const requestHash = request.requestHash;
  const savedStatus = await loadCommandStatus(deps.stateDir, commandId);
  if (!savedStatus) throw new Error(`Remote command status for "${commandId}" is missing; refusing to attach to an unknown lifecycle.`);
  const transportBudget = deps.reconnectBudgetMs ?? deps.config.backends.codespaces.transport.reconnectWindowSeconds * 1000;
  const deadline = Date.now() + transportBudget;
  let offsets = (await loadCommandOffsets(deps.stateDir, commandId)) ?? await zeroOffsets(deps, commandId, now);
  const helper = await bootstrapRemoteHelper(helperDeps(deps));
  await inspectRemoteHelper(helperDeps(deps), helper.arch, helper.file);
  let attempt = 0;
  while (attempt === 0 || (attempt > 0 && Date.now() < deadline && savedStatus.state !== 'exited')) {
    attempt += 1;
    let session: HelperSession | undefined;
    try {
      session = await openSession(deps, helper.binPath);
      await helloHandshake(deps, session, helper.arch);
      await session.send(HelperFrameType.attach, { command_id: commandId, request_hash: requestHash, stdout_offset: offsets.stdout, stderr_offset: offsets.stderr, terminal_offset: offsets.terminal, workspace_id: deps.metadata.workspaceId, grace_ms: deps.cancelGraceMs ?? deps.config.backends.codespaces.transport.cancelGraceSeconds * 1000 });
      const streaming = yield* streamSession(deps, now, commandId, requestHash, session, offsets);
      session = undefined;
      offsets = streaming.offsets;
      await saveOffsets(deps, offsets, now);
      if (streaming.outcome === 'exited') {
        await journal(deps.logger, deps.metadata, { event: 'command-terminal', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: savedStatus.state, next: `exited(${streaming.exitCode ?? 'null'})`, detail: null });
        yield { type: 'exit', commandId, code: streaming.exitCode };
        return;
      }
      if (streaming.outcome === 'cancelled') { yield { type: 'cancelled', commandId }; return; }
      if (streaming.outcome === 'rejected') { yield { type: 'rejected', commandId, reason: streaming.reason ?? 'rejected' }; return; }
    } catch (error: unknown) {
      if (session) { try { session.close(); } catch { /* closed */ } }
      session = undefined;
      const persisted = await loadCommandOffsets(deps.stateDir, commandId);
      if (persisted) offsets = persisted;
      if (!(error instanceof TransportLostError)) throw error;
    }
  }
  await saveOffsets(deps, offsets, now);
  await saveStatus(deps, statusRecord(commandId, now, 'detached', await loadCommandStatus(deps.stateDir, commandId) ?? savedStatus));
  yield { type: 'detached', commandId, offsets: offsetsBigint(offsets) };
}

export interface RemoteCancelOutcome { outcome: 'cancelled' | 'cancel-outcome-unknown'; recordedAt: string }

export async function cancelRemoteCommand(deps: RemoteTransportDependencies, commandId: string): Promise<RemoteCancelOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const request = await loadCommandRequest(deps.stateDir, commandId);
  if (!request) throw new Error(`No recorded remote command "${commandId}" exists to cancel.`);
  const requestHash = request.requestHash;
  const savedStatus = await loadCommandStatus(deps.stateDir, commandId);
  if (!savedStatus) throw new Error(`Remote command status for "${commandId}" is missing; refusing to cancel an unknown lifecycle.`);
  if (savedStatus.state === 'exited' || savedStatus.state === 'cancelled') return { outcome: 'cancelled', recordedAt: savedStatus.exitedAt ?? now() };
  const offsets = (await loadCommandOffsets(deps.stateDir, commandId)) ?? await zeroOffsets(deps, commandId, now);
  await journal(deps.logger, deps.metadata, { event: 'cancel-requested', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: savedStatus.state, next: 'cancelling', detail: null });
  const proof = await requestRemoteCancelProof(deps, commandId, requestHash, now);
  await saveOffsets(deps, offsets, now);
  if (proof === 'verified') {
    await saveStatus(deps, statusRecord(commandId, now, 'cancelled', savedStatus));
    await journal(deps.logger, deps.metadata, { event: 'cancel-verified', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: 'cancelling', next: 'cancelled', detail: null });
    return { outcome: 'cancelled', recordedAt: now() };
  }
  await recordUnknownOutcome(deps, commandId, requestHash, offsets, now, savedStatus, 'cancel-outcome-unknown');
  return { outcome: 'cancel-outcome-unknown', recordedAt: now() };
}

interface OpenExecSessionResult {
  kind: 'session' | 'rejected' | 'aborted';
  session?: HelperSession;
  reason?: string;
}

async function openExecSession(deps: RemoteTransportDependencies, helper: RemoteHelperBootstrapResult, commandId: string, requestHash: string, input: ExecuteTransportInput, _offsets: CodespacesCommandOffsets, now: () => string): Promise<OpenExecSessionResult> {
  if (deps.signal?.aborted) return { kind: 'aborted' };
  const session = await openSession(deps, helper.binPath);
  await helloHandshake(deps, session, helper.arch);
  await session.send(HelperFrameType.exec, {
    command_id: commandId,
    request_hash: requestHash,
    argv: [...input.argv],
    cwd: input.cwd ?? null,
    mode: input.mode,
    cols: input.mode === 'pty' ? (input.cols ?? 80) : undefined,
    rows: input.mode === 'pty' ? (input.rows ?? 24) : undefined,
    workspace_id: deps.metadata.workspaceId,
    grace_ms: deps.cancelGraceMs ?? deps.config.backends.codespaces.transport.cancelGraceSeconds * 1000,
    retention_bytes: deps.config.backends.codespaces.transport.remoteLogBytesPerStream,
    retention_hours: deps.config.backends.codespaces.transport.remoteLogRetentionHours,
  });
  return acknowledgeStarted(deps, session, commandId, requestHash, now);
}

async function openAttachSession(deps: RemoteTransportDependencies, helper: RemoteHelperBootstrapResult, commandId: string, requestHash: string, input: ExecuteTransportInput, offsets: CodespacesCommandOffsets, now: () => string): Promise<OpenExecSessionResult> {
  if (deps.signal?.aborted) return { kind: 'aborted' };
  const session = await openSession(deps, helper.binPath);
  await helloHandshake(deps, session, helper.arch);
  await session.send(HelperFrameType.attach, {
    command_id: commandId,
    request_hash: requestHash,
    stdout_offset: offsets.stdout,
    stderr_offset: offsets.stderr,
    terminal_offset: offsets.terminal,
    workspace_id: deps.metadata.workspaceId,
    grace_ms: deps.cancelGraceMs ?? deps.config.backends.codespaces.transport.cancelGraceSeconds * 1000,
  });
  return acknowledgeStarted(deps, session, commandId, requestHash, now, true);
}

async function acknowledgeStarted(deps: RemoteTransportDependencies, session: HelperSession, commandId: string, requestHash: string, now: () => string, reattaching = false): Promise<OpenExecSessionResult> {
  const first = await session.nextEvent();
  if (first === null) {
    session.close();
    throw new TransportLostError('The remote helper closed before acknowledging the session request.');
  }
  if (first.kind === 'rejected') {
    session.close();
    return { kind: 'rejected', reason: first.reason };
  }
  if (first.kind !== 'started') {
    session.close();
    throw new Error('The remote helper did not acknowledge execution with a verified started event.');
  }
  if (!reattaching) {
    await saveStatus(deps, statusRecord(commandId, now, 'running', await loadCommandStatus(deps.stateDir, commandId)));
    await journal(deps.logger, deps.metadata, { event: 'command-started', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: 'accepted', next: 'running', detail: null });
  }
  return { kind: 'session', session };
}

async function openSession(deps: RemoteTransportDependencies, binPath: string, signal = deps.signal): Promise<HelperSession> {
  const child = deps.spawner(['gh', 'codespace', 'ssh', '-c', deps.metadata.remote.name, '--', binPath, 'serve'], { signal });
  drainStderr(child);
  return new HelperSession(child);
}

function drainStderr(child: FramedChildProcess): void {
  child.stderr.on('data', () => {
    // SSH diagnostics are neither framed nor trusted; drain without retaining.
  });
}

async function helloHandshake(deps: RemoteTransportDependencies, session: HelperSession, expectedArch: 'linux-x64' | 'linux-arm64'): Promise<void> {
  await session.send(HelperFrameType.hello, { protocol: HELPER_PROTOCOL_VERSION, vendor: 'agent-containers' });
  const event = await session.nextEvent();
  if (event === null) throw new TransportLostError('The remote helper did not complete the protocol handshake before closing.');
  if (event.kind !== 'hello-ok') throw new Error('The remote helper did not confirm the package protocol handshake; execution is blocked.');
  if (event.protocol !== HELPER_PROTOCOL_VERSION) {
    throw new Error(`Remote helper protocol ${event.protocol} does not match the pinned package protocol ${HELPER_PROTOCOL_VERSION}; execution is blocked.`);
  }
  const observedArch = event.helperArch;
  const expectedArchName = expectedArch === 'linux-x64' ? 'x86_64' : 'aarch64';
  if (observedArch !== expectedArchName) {
    throw new Error(`Remote helper architecture ${redactSecretDiagnostic(observedArch)} does not match the package-owned artifact ${expectedArchName}; execution is blocked.`);
  }
  void deps;
}

interface StreamingOutcome {
  outcome: 'exited' | 'detached' | 'cancelled' | 'rejected';
  exitCode: number | null;
  reason?: string;
  offsets: CodespacesCommandOffsets;
}

async function* streamSession(deps: RemoteTransportDependencies, now: () => string, commandId: string, requestHash: string, session: HelperSession, initial: CodespacesCommandOffsets): AsyncGenerator<CommandEvent, StreamingOutcome> {
  const offsets = { ...initial };
  let stdoutCursor = BigInt(offsets.stdout);
  let stderrCursor = BigInt(offsets.stderr);
  let terminalCursor = BigInt(offsets.terminal);
  let queuedBytes = 0n;
  /* N7: a first interrupt arriving AFTER the session is established must
   * terminate the stream deterministically. Closing the session makes the
   * helper stream end, the caller re-enters its loop-top cancel gate, and the
   * bounded cancel-proof path emits cancel-unknown rather than hanging. */
  const onAbort = () => { void session.close(); };
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
  const persist = async (): Promise<void> => {
    const next: CodespacesCommandOffsets = { schemaVersion: 1, commandId, stdout: stdoutCursor.toString(), stderr: stderrCursor.toString(), terminal: terminalCursor.toString(), updatedAt: now() };
    await saveOffsets(deps, next, now);
    Object.assign(offsets, next);
    queuedBytes = 0n;
  };
  while (true) {
    const event = await session.nextEvent();
    if (event === null) {
      await persist();
      throw new TransportLostError('The remote helper stream ended without a verified terminal outcome.');
    }
    switch (event.kind) {
      case 'output': {
        let cursor = event.stream === 'stdout' ? stdoutCursor : event.stream === 'stderr' ? stderrCursor : terminalCursor;
        if (event.offset < cursor) throw new Error(`Remote helper emitted overlapping output at offset ${event.offset} below the acknowledged cursor ${cursor}; refusing duplicate frames.`);
        if (event.offset > cursor) throw new Error(`Remote helper skipped output between offset ${cursor} and ${event.offset}; refusing a lossy stream.`);
        cursor += BigInt(event.bytes.length);
        if (event.stream === 'stdout') stdoutCursor = cursor;
        else if (event.stream === 'stderr') stderrCursor = cursor;
        else terminalCursor = cursor;
        queuedBytes += BigInt(event.bytes.length);
        if (queuedBytes >= BigInt(OFFSET_PERSIST_THRESHOLD)) await persist();
        yield { type: event.stream, commandId, offset: event.offset, bytes: event.bytes };
        break;
      }
      case 'exit': {
        if (event.code !== null && (event.code < 0 || event.code > 255)) throw new Error(`Remote helper reported an impossible exit code ${event.code}; refusing the unproven outcome.`);
        const current = (await loadCommandStatus(deps.stateDir, commandId)) ?? statusRecord(commandId, now, 'running');
        await saveStatus(deps, { ...statusRecord(commandId, now, 'exited', current), exitCode: event.code, exitedAt: event.exitedAt });
        await persist();
        return { outcome: 'exited', exitCode: event.code, offsets };
      }
      case 'rejected': {
        return { outcome: 'rejected', exitCode: null, reason: event.reason, offsets };
      }
      case 'cancel-verified': {
        await saveStatus(deps, statusRecord(commandId, now, 'cancelled', await loadCommandStatus(deps.stateDir, commandId)));
        await persist();
        return { outcome: 'cancelled', exitCode: null, offsets };
      }
      case 'error': {
        throw new Error(`Remote helper reported an error: ${redactSecretDiagnostic(event.message)}`);
      }
      case 'status': {
        if (event.state === 'exited') {
          const current = (await loadCommandStatus(deps.stateDir, commandId)) ?? statusRecord(commandId, now, 'exited');
          await saveStatus(deps, { ...statusRecord(commandId, now, 'exited', current), exitCode: event.exitCode });
        }
        break;
      }
      default:
        break;
    }
  }
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

async function recordUnknownOutcome(deps: RemoteTransportDependencies, commandId: string, requestHash: string, offsets: CodespacesCommandOffsets, now: () => string, base: CodespacesCommandStatus | undefined, state: CodespacesCommandStatus['state']): Promise<void> {
  await saveOffsets(deps, offsets, now);
  await saveStatus(deps, statusRecord(commandId, now, state, base));
  await journal(deps.logger, deps.metadata, { event: 'cancel-unknown', operationId: randomUUID(), requestId: null, codespaceId: deps.metadata.remote.codespaceId, commandId, requestHash, previous: 'cancelling', next: state, detail: 'The remote process group could not be proven stopped; the command may still run.' });
  await recordCommandRecovery(deps.stateDir, { commandId, workspaceName: deps.metadata.name, reason: 'cancel-outcome-unknown' });
  await setMetadataRecovery(deps, 'remote-exec-interrupted');
}

/** First-interrupt behavior: request a verified remote cancel and only report success after remote proof. */
async function requestRemoteCancelProof(deps: RemoteTransportDependencies, commandId: string, requestHash: string, now: () => string): Promise<'verified' | 'unknown'> {
  const grace = deps.cancelGraceMs ?? deps.config.backends.codespaces.transport.cancelGraceSeconds * 1000;
  const budget = deps.reconnectBudgetMs ?? deps.config.backends.codespaces.transport.reconnectWindowSeconds * 1000;
  const deadline = Date.now() + budget + grace;
  let session: HelperSession | undefined;
  let detached = deps.detachSignal?.aborted ?? false;
  const onDetach = () => { detached = true; session?.close(); };
  deps.detachSignal?.addEventListener('abort', onDetach, { once: true });
  try {
    if (detached) return 'unknown';
    const helper = await bootstrapRemoteHelper(helperDeps(deps));
    if (detached) return 'unknown';
    session = await openSession(deps, helper.binPath, deps.detachSignal);
    if (detached) return 'unknown';
    await helloHandshake(deps, session, helper.arch);
    if (detached) return 'unknown';
    await session.send(HelperFrameType.cancel, { command_id: commandId, request_hash: requestHash, workspace_id: deps.metadata.workspaceId, grace_ms: deps.cancelGraceMs ?? deps.config.backends.codespaces.transport.cancelGraceSeconds * 1000 });
    if (detached) return 'unknown';
    const verified = await waitForCancelVerified(deps, session, commandId, deadline);
    if (verified && !detached) return 'verified';
  } catch (error: unknown) {
    if (error instanceof Error && error.name !== 'AbortError') throw error;
  } finally {
    session?.close();
    deps.detachSignal?.removeEventListener('abort', onDetach);
  }
  void now;
  return 'unknown';
}

async function waitForCancelVerified(deps: RemoteTransportDependencies, session: HelperSession, commandId: string, deadlineMs: number): Promise<boolean> {
  const cancelDetach = { aborted: false };
  const onDetach = () => { cancelDetach.aborted = true; session.close(); };
  deps.detachSignal?.addEventListener('abort', onDetach, { once: true });
  const timer = setTimeout(() => session.close(), Math.max(0, deadlineMs - Date.now()));
  try {
    while (Date.now() < deadlineMs) {
      let event;
      try {
        event = await session.nextEvent();
      } catch {
        return false;
      }
      if (event === null) return false;
      if (event.kind === 'cancel-verified') return true;
      if (event.kind === 'cancel-unknown') return false;
      if (event.kind === 'error' || event.kind === 'rejected') return false;
      if (cancelDetach.aborted) return false;
    }
    return false;
  } finally {
    clearTimeout(timer);
    deps.detachSignal?.removeEventListener('abort', onDetach);
  }
}

export function offsetsBigint(offsets: CodespacesCommandOffsets): { stdout: bigint; stderr: bigint; terminal: bigint } {
  return { stdout: BigInt(offsets.stdout), stderr: BigInt(offsets.stderr), terminal: BigInt(offsets.terminal) };
}

async function zeroOffsets(deps: RemoteTransportDependencies, commandId: string, now: () => string): Promise<CodespacesCommandOffsets> {
  const offsets = { schemaVersion: 1 as const, commandId, stdout: '0', stderr: '0', terminal: '0', updatedAt: now() };
  await saveCommandOffsets(deps.stateDir, offsets);
  return offsets;
}

async function saveOffsets(deps: RemoteTransportDependencies, offsets: CodespacesCommandOffsets, now: () => string): Promise<CodespacesCommandOffsets> {
  await saveCommandOffsets(deps.stateDir, { ...offsets, updatedAt: now() });
  return offsets;
}

async function saveStatus(deps: RemoteTransportDependencies, status: CodespacesCommandStatus): Promise<CodespacesCommandStatus> {
  await saveCommandStatus(deps.stateDir, status);
  return status;
}

export function helperDeps(deps: RemoteTransportDependencies): Parameters<typeof bootstrapRemoteHelper>[0] {
  return {
    stateDir: deps.stateDir,
    workspaceName: deps.metadata.name,
    workspaceId: deps.metadata.workspaceId,
    remoteName: deps.metadata.remote.name,
    provider: deps.provider,
    root: deps.root,
    sshTimeoutMs: deps.sshTimeoutMs,
    signal: deps.detachSignal,
    now: deps.now,
    verifyKnown: true,
  };
}

async function journal(logger: RemoteTransportDependencies['logger'], metadata: CodespacesWorkspaceMetadata, input: Omit<CodespacesJournalEventInput, 'workspaceName' | 'actorId' | 'repositoryId'>): Promise<void> {
  if (!logger) return;
  await logger({ ...input, workspaceName: metadata.name, actorId: metadata.control.actorId, repositoryId: metadata.repository.id });
}

async function setMetadataRecovery(deps: RemoteTransportDependencies, reason: string): Promise<void> {
  const current = await loadMetadata(deps.stateDir, deps.metadata.name);
  if (!current || current.version !== 2 || current.backend !== 'codespaces') return;
  const next = { ...current, recovery: { reason, operationId: randomUUID(), recordedAt: deps.now?.() ?? new Date().toISOString() } };
  try {
    await saveMetadata(deps.stateDir, next, { expectedGeneration: metadataGeneration(current) });
  } catch {
    // The durable command recovery record remains authoritative if the
    // metadata barrier races another writer.
  }
}