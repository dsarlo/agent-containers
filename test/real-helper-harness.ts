import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodespacesProviderProcess } from '../src/codespaces.js';
import {
  HelperFrameDecoder, HelperFrameType, encodeFrame, encodeJsonFrame, decodeFramedJson, decodeOutputEvent,
  type HelperFrame, type OutputStreamName,
} from '../src/codespaces-protocol.js';
import type { FramedChildProcess, SshSpawner } from '../src/codespaces-transport.js';
import { decodedRemoteSshArgv } from './transport-fixtures.js';

/**
 * Real-binary harness (N2): drives the committed static helper artifact over
 * stdio pipes with the framed protocol directly — no SSH, no mock. The spawned
 * helper must be the on-disk native/helper/bin binary so every transport
 * semantic (attach resume, verified cancel, merged PTY, half-close durability,
 * argv corpus, exit status) is exercised against the real implementation.
 */
export function repositoryRoot(): string {
  const start = fileURLToPath(new URL('../', import.meta.url));
  let current = start;
  for (;;) {
    if (existsSync(join(current, 'native', 'helper', 'bin'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('unable to locate the repository native/helper/bin tree');
    current = parent;
  }
}

export function realHelperBinaryPath(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined;
  if (!arch) return undefined;
  return join(repositoryRoot(), 'native', 'helper', 'bin', `agent-containers-helper-linux-${arch}`);
}

export function helperDataRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-containers-helper-data-'));
}

export function commandDir(dataDir: string, workspaceId: string, commandId: string): string {
  return join(dataDir, workspaceId, 'commands', commandId);
}

export interface RealOutputEvent { kind: 'output'; stream: OutputStreamName; offset: bigint; bytes: Uint8Array }
export interface RealJsonEvent { kind: string; [key: string]: unknown }

export async function runRealHandshake(binPath: string): Promise<string> {
  return await new Promise<string>((resolveOut, reject) => {
    const child = spawn(binPath, ['handshake'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: string | Uint8Array) => { out += typeof d === 'string' ? d : Buffer.from(d).toString(); });
    child.stderr.on('data', (d: string | Uint8Array) => { err += typeof d === 'string' ? d : Buffer.from(d).toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`helper handshake exited ${code}: ${err}`));
      else resolveOut(out.trim());
    });
  });
}

/** A live framed connection to the real helper serve process. */
export class RealHelperProcess {
  private readonly child: ChildProcess;
  private readonly decoder = new HelperFrameDecoder();
  private readonly pend: HelperFrame[] = [];
  private readonly waiters: Array<(frame: HelperFrame | null) => void> = [];
  private ended = false;
  private readonly closeWaiters: Array<() => void> = [];

  constructor(binPath: string, dataDir: string, environment: NodeJS.ProcessEnv = {}) {
    this.child = spawn(binPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...environment, AC_HELPER_DATA_DIR: dataDir } });
    this.child.stderr!.on('data', () => { /* helper diagnostics are not framed */ });
    this.child.stdout!.on('data', (chunk: string | Uint8Array) => {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      let frames: HelperFrame[];
      try { frames = this.decoder.push(bytes); } catch { this.finish(); return; }
      for (const frame of frames) this.deliver(frame);
    });
    this.child.stdout!.on('error' as never, () => this.finish());
    this.child.stdout!.on('end', () => {
      try { for (const frame of this.decoder.flush()) this.deliver(frame); } catch { this.finish(); return; }
      this.finish();
    });
    this.child.stdout!.on('close', () => this.finish());
    this.child.once('close', () => this.finish());
  }

  private deliver(frame: HelperFrame): void {
    if (this.waiters.length > 0) (this.waiters.shift() as (frame: HelperFrame | null) => void)(frame);
    else this.pend.push(frame);
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) (this.waiters.shift() as (frame: HelperFrame | null) => void)(null);
    while (this.closeWaiters.length > 0) (this.closeWaiters.shift() as () => void)();
  }

  /** Perform the client hello handshake: send hello and await the package hello-ok. */
  async autoHello(): Promise<{ protocol: number; helperVersion: string; helperArch: string; remoteBootId: string }> {
    this.child.stdin!.write(encodeJsonFrame(HelperFrameType.hello, { protocol: 1, vendor: 'agent-containers' }));
    const event = await this.nextTyped();
    assert.ok(event !== null && event.kind === 'hello-ok', 'the real helper must confirm the package hello handshake');
    return { protocol: event.protocol as number, helperVersion: event.helper_version as string, helperArch: event.helper_arch as string, remoteBootId: event.remote_boot_id as string };
  }

  async nextFrame(): Promise<HelperFrame | null> {
    if (this.pend.length > 0) return this.pend.shift() as HelperFrame;
    if (this.ended) return null;
    return await new Promise<HelperFrame | null>((resolveFrame) => this.waiters.push(resolveFrame));
  }

  async nextJson(): Promise<RealJsonEvent | null> {
    const frame = await this.nextFrame();
    if (frame === null) return null;
    if (frame.type === HelperFrameType.output) {
      const decoded = decodeOutputEvent(frame.payload);
      return { kind: 'output', stream: decoded.stream, offset: decoded.offset, bytes: decoded.bytes };
    }
    const kind =
      frame.type === HelperFrameType.helloOk ? 'hello-ok'
        : frame.type === HelperFrameType.rejected ? 'rejected'
          : frame.type === HelperFrameType.started ? 'started'
            : frame.type === HelperFrameType.status ? 'status'
              : frame.type === HelperFrameType.exit ? 'exit'
                : frame.type === HelperFrameType.cancelVerified ? 'cancel-verified'
                  : frame.type === HelperFrameType.cancelUnknown ? 'cancel-unknown'
                    : frame.type === HelperFrameType.error ? 'error'
                      : `unknown-${frame.type}`;
    return { ...decodeFramedJson<Record<string, unknown>>(frame), kind };
  }

  async nextTyped(): Promise<RealJsonEvent | null> {
    return this.nextJson();
  }

  /** Read output/cancel/exit events until a predicate is satisfied or the
   * stream closes. `take` collects contiguous output bytes per stream. */
  async until(predicate: (event: RealJsonEvent) => boolean, deadlineMs: number): Promise<RealJsonEvent[]> {
    const events: RealJsonEvent[] = [];
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const event = await this.nextTyped();
      if (event === null) break;
      events.push(event);
      if (predicate(event)) return events;
    }
    throw new Error(`real helper session timed out before the expected event (seen ${events.length} events)`);
  }

  writeFrame(type: number, payload: Uint8Array | Record<string, unknown>): void {
    const bytes = payload instanceof Uint8Array ? encodeFrame(type, payload) : encodeJsonFrame(type, payload);
    this.child.stdin!.write(bytes);
  }

  sendStdinEof(payload: Record<string, unknown>): void {
    this.child.stdin!.write(encodeJsonFrame(HelperFrameType.stdinEof, payload));
  }

  sendStdin(payload: Uint8Array, maxChunk?: number): void {
    if (maxChunk === undefined || payload.length <= maxChunk) {
      this.writeFrame(HelperFrameType.stdin, payload);
      return;
    }
    for (let offset = 0; offset < payload.length; offset += maxChunk) {
      this.writeFrame(HelperFrameType.stdin, payload.subarray(offset, Math.min(offset + maxChunk, payload.length)));
    }
  }

  endStdin(): void {
    try { this.child.stdin!.end(); } catch { /* already closed */ }
  }

  pid(): number | undefined {
    return this.child.pid;
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    try { this.child.kill(signal); } catch { /* already gone */ }
  }

  async closed(): Promise<void> {
    if (this.ended || this.child.exitCode !== null) return;
    await new Promise<void>((resolveClose) => this.closeWaiters.push(resolveClose));
  }
}

/** Reassemble output events for a stream into a Buffer. */
export function reassembleOutput(events: readonly RealJsonEvent[], stream: OutputStreamName): Buffer {
  return Buffer.concat(events
    .filter((event) => event.kind === 'output' && (event as unknown as RealOutputEvent).stream === stream)
    .map((event) => Buffer.from((event as unknown as RealOutputEvent).bytes)));
}

/** Route the fixed bootstrap probes; `... handshake` argv executes the real
 * binary so the handshake arch/version are genuine. The digest/lstat probes
 * return the package-owned fixture pin (the transport verifies against the
 * manifest, not the host binary). (N2) */
export function realBootstrapRunner(binPath: string, remoteDigest: string): CodespacesProviderProcess {
  return {
    async run(command, args, runOptions) {
      assert.equal(command, 'gh');
      if (!args.join(' ').startsWith('codespace ssh -c ')) throw new Error(`unrouted bootstrap argv: ${JSON.stringify(args)}`);
      const remote = decodedRemoteSshArgv(args);
      const argv = remote.join(' ');
      if (argv === 'uname -m') return { code: 0, stdout: `${realHelperBinaryPath()?.includes('arm64') ? 'aarch64' : 'x86_64'}\n`, stderr: '' };
      if (argv === 'id -u') return { code: 0, stdout: '1000\n', stderr: '' };
      if (argv.startsWith('mkdir -p')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('chmod 0700 ')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('mv ')) return { code: 0, stdout: '', stderr: '' };
      if (argv.startsWith('tee ')) {
        assert.ok(runOptions?.binaryInput !== undefined, 'copy must stream package-owned bytes');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv.startsWith('sha256sum ')) {
        return { code: 0, stdout: `${remoteDigest}  ${argv.split(' ')[1]}\n`, stderr: '' };
      }
      if (argv.startsWith('stat -c %F|%a|%u|%g ')) {
        return { code: 0, stdout: 'regular file|700|1000|1000\n', stderr: '' };
      }
      if (argv.endsWith(' handshake')) {
        const output = await runRealHandshake(binPath);
        return { code: 0, stdout: `${output}\n`, stderr: '' };
      }
      throw new Error(`unrouted bootstrap remote argv: ${argv}`);
    },
  };
}

/** Real-binary SshSpawner: accepts only the encoded package-owned helper serve
 * command, then runs the actual host artifact against the test data root. */
const spawnedRelays = new Set<ChildProcess>();
export function killSpawnedRelays(): void {
  for (const child of spawnedRelays) {
    try { child.stdin?.end(); } catch { /* closed */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  spawnedRelays.clear();
}

export function createRealHelperSpawner(binPath: string, dataDir: string): SshSpawner {
  return (argv) => {
    const remote = decodedRemoteSshArgv(argv);
    if (remote.length !== 2 || remote[1] !== 'serve' || !remote[0]?.startsWith('/workspaces/.agent-containers/')) {
      throw new Error(`unrouted real helper SSH argv: ${JSON.stringify(argv)}`);
    }
    const child = spawn(binPath, ['serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AC_HELPER_DATA_DIR: dataDir },
    });
    spawnedRelays.add(child);
    child.once('close', () => spawnedRelays.delete(child));
    const framed: FramedChildProcess = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      kill: (signal?: NodeJS.Signals) => child.kill(signal ?? 'SIGTERM'),
      once: (event, listener) => { child.once(event as never, listener as never); return framed; },
    };
    return framed;
  };
}