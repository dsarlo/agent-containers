import { PassThrough } from 'node:stream';
import type { FramedChildProcess, SshSpawner } from '../src/codespaces-transport.js';
import {
  HelperFrameDecoder, HelperFrameType, encodeFrame, encodeJsonFrame, encodeOutputEvent, type HelperFrame,
} from '../src/codespaces-protocol.js';

export const MOCK_BOOT_ID = '11111111-2222-4333-8444-555555555555';

export type MockStreamKind = 'stdout' | 'stderr' | 'terminal';
export interface MockOutputEvent { stream: MockStreamKind; bytes: Uint8Array }

export type MockCancelPolicy = 'verify' | 'never';

export interface MockCommandBehavior {
  commandId: string;
  outputs?: MockOutputEvent[];
  exitCode?: number | null;
  rejectReason?: string;
  /** Destroy the SSH socket after this many output frames (transport-loss injection). */
  dropAfterOutputs?: number;
  cancelProofDelayMs?: number;
  cancelPolicy?: MockCancelPolicy;
  /** Do not auto-send the scheduled exit (keep the command running remotely). */
  stayRunning?: boolean;
  /** Pause between output frames to exercise socket backpressure. */
  sendOutputDelayMs?: number;
  /** Reported helper_arch in hello-ok (default 'x86_64'); used to cross-check N1. */
  helperArch?: string;
}

export interface MockCommandRecord {
  commandId: string;
  hash: string;
  mode: 'pipe' | 'pty';
  argv: string[];
  logs: Record<MockStreamKind, Uint8Array[]>;
  totals: Record<MockStreamKind, bigint>;
  exitCode: number | null;
  exited: boolean;
  begin: string | null;
  logsAppended: boolean;
  dropTriggered: boolean;
}

export class MockRemoteHelper {
  readonly behaviors = new Map<string, MockCommandBehavior>();
  readonly records = new Map<string, MockCommandRecord>();
  readonly cancelRequests: string[] = [];
  readonly resizes: Array<{ commandId: string; cols: number; rows: number }> = [];
  protocol = 1;
  helperArch = 'x86_64';

  configure(behavior: MockCommandBehavior): void {
    this.behaviors.set(behavior.commandId, behavior);
    if (behavior.helperArch) this.helperArch = behavior.helperArch;
  }

  begin(record: MockCommandRecord): void {
    this.records.set(record.commandId, record);
  }

  reset(): void {
    this.records.clear();
    this.cancelRequests.length = 0;
    this.behaviors.clear();
  }
}

export class MockSshSession {
  private readonly decoder = new HelperFrameDecoder();
  private readonly pending: HelperFrame[] = [];
  private readonly frameWaiters: Array<(frame: HelperFrame | null) => void> = [];
  private failure: Error | null = null;
  private inputEnded = false;
  private closed = false;
  private readonly closeWaiters: Array<() => void> = [];

  constructor(
    readonly input: NodeJS.ReadableStream,
    readonly output: NodeJS.WritableStream,
    readonly argv: readonly string[],
  ) {
    input.on('data', (chunk: string | Uint8Array) => {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      try {
        for (const frame of this.decoder.push(bytes)) this.enqueue(frame);
      } catch (error: unknown) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.drain();
      }
    });
    input.on('end', () => { this.inputEnded = true; this.drain(); });
    input.on('error', (error: Error) => { this.failure = error; this.drain(); });
  }

  private enqueue(frame: HelperFrame): void {
    if (this.frameWaiters.length > 0) (this.frameWaiters.shift() as (frame: HelperFrame | null) => void)(frame);
    else this.pending.push(frame);
  }

  private drain(): void {
    this.inputEnded = true;
    while (this.frameWaiters.length > 0) (this.frameWaiters.shift() as (frame: HelperFrame | null) => void)(null);
  }

  async nextFrame(): Promise<HelperFrame | null> {
    for (;;) {
      if (this.pending.length > 0) return this.pending.shift() as HelperFrame;
      if (this.inputEnded) {
        if (this.failure) { const error = this.failure; this.failure = null; throw error; }
        return null;
      }
      const frame = await new Promise<HelperFrame | null>((resolve) => this.frameWaiters.push(resolve));
      if (frame !== null) return frame;
    }
  }

  async sendJson(type: number, value: unknown): Promise<void> {
    await this.write(encodeJsonFrame(type, value));
  }

  async write(frame: Uint8Array): Promise<void> {
    if (this.closed) return;
    if (!this.output.write(frame)) await new Promise<void>((resolve) => this.output.once('drain', resolve));
  }

  async sendOutput(stream: MockStreamKind, offset: bigint, bytes: Uint8Array): Promise<void> {
    const code = stream === 'stdout' ? 0 : stream === 'stderr' ? 1 : 2;
    await this.write(encodeFrame(HelperFrameType.output, encodeOutputEvent(code, offset, bytes)));
  }

  get isClosed(): boolean { return this.closed; }

  async untilClosed(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => this.closeWaiters.push(resolve));
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.closeWaiters.length > 0) (this.closeWaiters.shift() as () => void)();
    try { this.output.end(); } catch { /* closed */ }
  }
}

export interface MockSshCall { argv: readonly string[]; session: MockSshSession }

export function createMockSshSpawner(helper: MockRemoteHelper, onSpawn?: (call: MockSshCall) => void): SshSpawner {
  return (argv) => {
    const spawnedIn = new PassThrough();
    const spawnedOut = new PassThrough({ highWaterMark: 1024 });
    const spawnedErr = new PassThrough();
    const session = new MockSshSession(spawnedIn, spawnedOut, argv);
    if (onSpawn) onSpawn({ argv, session });
    void serveSession(helper, session, argv);
    const child: FramedChildProcess = {
      stdin: spawnedIn,
      stdout: spawnedOut,
      stderr: spawnedErr,
      pid: 4242,
      kill: () => {
        session.destroy();
        return true;
      },
      once: (event, listener) => {
        spawnedOut.once(event, listener);
        return child;
      },
    };
    return child;
  };
}

async function serveSession(helper: MockRemoteHelper, session: MockSshSession, argv: readonly string[]): Promise<void> {
  if (!argv.join(' ').includes('serve') && !argv.join(' ').includes('handshake')) return;
  for (;;) {
    let frame: HelperFrame | null;
    try {
      frame = await session.nextFrame();
    } catch {
      break;
    }
    if (frame === null) break;
    try {
      await handleRequest(helper, session, frame);
    } catch {
      break;
    }
  }
  session.destroy();
}

async function sendHello(session: MockSshSession, protocol: number, arch: string): Promise<void> {
  await session.sendJson(HelperFrameType.helloOk, {
    protocol, helper_version: '0.1.0', helper_arch: arch, remote_boot_id: MOCK_BOOT_ID, helper_pid: 4242,
  });
}

async function handleRequest(helper: MockRemoteHelper, session: MockSshSession, frame: HelperFrame): Promise<void> {
  switch (frame.type) {
    case HelperFrameType.hello:
      await sendHello(session, helper.protocol, helper.helperArch);
      break;
    case HelperFrameType.exec: {
      const request = parseJson<{ command_id: string; request_hash: string; argv: string[]; mode?: 'pipe' | 'pty' }>(frame.payload);
      const behavior = helper.behaviors.get(request.command_id);
      let record = helper.records.get(request.command_id);
      if (record && record.hash !== request.request_hash) {
        await session.sendJson(HelperFrameType.rejected, { command_id: request.command_id, reason: 'id-hash-mismatch' });
        return;
      }
      if (!record) {
        record = newRecord(request.command_id, request.request_hash, request.argv, behavior);
        helper.begin(record);
      }
      if (behavior?.rejectReason) {
        await session.sendJson(HelperFrameType.rejected, { command_id: request.command_id, reason: behavior.rejectReason });
        return;
      }
      await session.sendJson(HelperFrameType.started, { command_id: request.command_id, pid: 5252, started_at: record.begin ?? new Date().toISOString(), remote_boot_id: MOCK_BOOT_ID });
      await pump(helper, session, record, behavior, { stdout: 0n, stderr: 0n, terminal: 0n });
      break;
    }
    case HelperFrameType.attach: {
      const request = parseJson<{ command_id: string; request_hash: string; stdout_offset?: string; stderr_offset?: string; terminal_offset?: string }>(frame.payload);
      const record = helper.records.get(request.command_id);
      if (!record || record.hash !== request.request_hash) {
        await session.sendJson(HelperFrameType.rejected, { command_id: request.command_id, reason: 'unknown-command' });
        return;
      }
      await session.sendJson(HelperFrameType.started, { command_id: request.command_id, pid: 5252, started_at: record.begin ?? new Date().toISOString(), remote_boot_id: MOCK_BOOT_ID });
      await pump(helper, session, record, helper.behaviors.get(request.command_id), {
        stdout: request.stdout_offset ? BigInt(request.stdout_offset) : 0n,
        stderr: request.stderr_offset ? BigInt(request.stderr_offset) : 0n,
        terminal: request.terminal_offset ? BigInt(request.terminal_offset) : 0n,
      });
      break;
    }
    case HelperFrameType.cancel: {
      const request = parseJson<{ command_id: string; request_hash: string }>(frame.payload);
      helper.cancelRequests.push(request.command_id);
      const record = helper.records.get(request.command_id);
      if (!record) {
        await session.sendJson(HelperFrameType.rejected, { command_id: request.command_id, reason: 'unknown-command' });
        return;
      }
      const policy = helper.behaviors.get(request.command_id)?.cancelPolicy ?? 'verify';
      const delay = helper.behaviors.get(request.command_id)?.cancelProofDelayMs ?? 0;
      if (policy === 'never') {
        return;
      }
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          void session.untilClosed().then(() => { clearTimeout(timer); resolve(); });
        });
        // A transport cancellation preempts the synthetic proof; never retain
        // this mock timer or emit a proof into a closed session.
        if (session.isClosed) return;
      }
      record.exited = true;
      record.exitCode = 130;
      const cancelledAt = new Date().toISOString();
      await session.sendJson(HelperFrameType.cancelVerified, { command_id: request.command_id, cancelled_at: cancelledAt });
      break;
    }
    case HelperFrameType.stdinEof:
      /* Client half-close of stdin (B4): the child keeps running detached from
       * the stream. The mock has no live child, so it is a no-op. */
      break;
    case HelperFrameType.resize: {
      const request = parseJson<{ command_id?: string; cols?: number; rows?: number }>(frame.payload);
      if (!request.command_id || !Number.isInteger(request.cols) || !Number.isInteger(request.rows)) {
        await session.sendJson(HelperFrameType.error, { command_id: request.command_id ?? null, message: 'invalid resize' });
        break;
      }
      helper.resizes.push({ commandId: request.command_id, cols: request.cols as number, rows: request.rows as number });
      break;
    }
    default:
      await session.sendJson(HelperFrameType.error, { command_id: null, message: `unsupported frame ${frame.type}` });
  }
}

function newRecord(commandId: string, hash: string, argv: string[], behavior: MockCommandBehavior | undefined): MockCommandRecord {
  return {
    commandId, hash, mode: 'pipe', argv,
    logs: { stdout: [], stderr: [], terminal: [] }, totals: { stdout: 0n, stderr: 0n, terminal: 0n },
    exitCode: behavior?.exitCode ?? 0, exited: false, begin: new Date().toISOString(), logsAppended: false, dropTriggered: false,
  };
}

async function pump(helper: MockRemoteHelper, session: MockSshSession, record: MockCommandRecord, behavior: MockCommandBehavior | undefined, from: { stdout: bigint; stderr: bigint; terminal: bigint }): Promise<void> {
  const schedule = behavior?.outputs ?? [];
  if (!record.logsAppended) {
    for (const event of schedule) {
      record.logs[event.stream].push(event.bytes);
      record.totals[event.stream] += BigInt(event.bytes.length);
    }
    record.logsAppended = true;
  }
  let sent = 0;
  for (const stream of ['stdout', 'stderr', 'terminal'] as const) {
    const requested = from[stream];
    let acc = 0n;
    for (const chunk of record.logs[stream]) {
      const start = acc;
      const end = acc + BigInt(chunk.length);
      if (end > requested) {
        const trim = requested > start ? requested - start : 0n;
        const tail = chunk.subarray(Number(trim));
        if (tail.length > 0) {
          await session.sendOutput(stream, start + trim, tail);
          sent += 1;
          if (!record.dropTriggered && behavior?.dropAfterOutputs !== undefined && sent >= behavior.dropAfterOutputs) {
            record.dropTriggered = true;
            session.destroy();
            return;
          }
          if (behavior?.sendOutputDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.sendOutputDelayMs));
          void helper;
        }
      }
      acc = end;
    }
  }
  if (!behavior?.stayRunning && record.exitCode !== null) {
    record.exited = true;
    await session.sendJson(HelperFrameType.exit, { command_id: record.commandId, code: record.exitCode ?? 0, exited_at: new Date().toISOString() });
  }
}

function parseJson<T>(payload: Uint8Array): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error('Mock helper received an invalid JSON request frame.');
  }
  return value as T;
}