import { createHash } from 'node:crypto';

/**
 * Wire protocol for the package-owned remote execution helper. Every frame is
 * `[type:u8][length:u32 big-endian][payload]`, length-prefixed and therefore
 * binary-safe. ASCII/JSON request/event headers carry nonsecret metadata; the
 * output event carries raw bytes only for the connected caller. Nothing on this wire ever
 * carries a credential-shaped value.
 */
export const HELPER_PROTOCOL_VERSION = 1;
export const HELPER_VENDOR = 'agent-containers';
export const MAX_HELPER_FRAME_PAYLOAD = 1024 * 1024;

export const HelperFrameType = {
  hello: 0x01,
  exec: 0x02,
  attach: 0x03,
  cancel: 0x04,
  resize: 0x05,
  stdin: 0x06,
  stdinEof: 0x07,
  helloOk: 0x81,
  rejected: 0x82,
  started: 0x83,
  output: 0x84,
  status: 0x85,
  exit: 0x86,
  cancelVerified: 0x87,
  error: 0x88,
  cancelUnknown: 0x89,
} as const;

export const OutputStream = { stdout: 0, stderr: 1, terminal: 2 } as const;
export type OutputStreamName = keyof typeof OutputStream;

export interface HelperFrame {
  type: number;
  payload: Uint8Array;
}

export function resolveOutputStream(code: number): OutputStreamName {
  if (code === OutputStream.stdout) return 'stdout';
  if (code === OutputStream.stderr) return 'stderr';
  if (code === OutputStream.terminal) return 'terminal';
  throw new Error(`Helper output stream code ${code} is outside the documented protocol.`);
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) throw new Error(`Helper frame type must be a single byte; got ${type}.`);
  if (!(payload instanceof Uint8Array) || payload.length > MAX_HELPER_FRAME_PAYLOAD) throw new Error('Helper frame payload exceeds the bounded maximum; refusing the oversized frame.');
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = type;
  frame[1] = (payload.length >>> 24) & 0xff;
  frame[2] = (payload.length >>> 16) & 0xff;
  frame[3] = (payload.length >>> 8) & 0xff;
  frame[4] = payload.length & 0xff;
  frame.set(payload, 5);
  return frame;
}

export function encodeJsonFrame(type: number, value: unknown): Uint8Array {
  return encodeFrame(type, new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeFramedJson<T>(frame: HelperFrame | Uint8Array): T {
  const payload = frame instanceof Uint8Array ? frame : frame.payload;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error('Helper frame contained invalid JSON; refusing to interpret the payload.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Helper frame JSON must be a single object.');
  }
  return value as T;
}

/** Raw output payload: `[stream:u8][offset:u64 big-endian][bytes]`. */
export function encodeOutputEvent(stream: number, offset: bigint, bytes: Uint8Array): Uint8Array {
  if (offset < 0n) throw new Error('Helper output offset must be nonnegative.');
  if (bytes.length > MAX_HELPER_FRAME_PAYLOAD - 9) throw new Error('Helper output chunk exceeds the byte bound.');
  const payload = new Uint8Array(9 + bytes.length);
  payload[0] = stream;
  writeUint64BE(payload, 1, offset);
  payload.set(bytes, 9);
  return payload;
}

export function decodeOutputEvent(payload: Uint8Array): { stream: OutputStreamName; offset: bigint; bytes: Uint8Array } {
  if (payload.length < 9) throw new Error('Helper output event is truncated; refusing a partial stream offset.');
  const stream = resolveOutputStream(payload[0]);
  const offset = readUint64BE(payload, 1);
  return { stream, offset, bytes: payload.subarray(9) };
}

export class HelperFrameDecoder {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): HelperFrame[] {
    const combined = new Uint8Array(this.pending.length + chunk.length);
    combined.set(this.pending, 0);
    combined.set(chunk, this.pending.length);
    this.pending = combined;
    const frames: HelperFrame[] = [];
    let offset = 0;
    while (this.pending.length - offset >= 5) {
      const length = readUint32BE(this.pending, offset + 1);
      if (length > MAX_HELPER_FRAME_PAYLOAD) throw new Error('Helper frame length exceeds the bounded maximum; refusing the oversized frame.');
      const total = 5 + length;
      if (this.pending.length - offset < total) break;
      frames.push({ type: this.pending[offset], payload: this.pending.subarray(offset + 5, offset + total) });
      offset += total;
    }
    if (offset > 0) this.pending = this.pending.subarray(offset);
    return frames;
  }

  /** Report any buffered partial frame so a clean close cannot mask truncation. */
  flush(): HelperFrame[] {
    if (this.pending.length > 0) {
      const length = this.pending.length >= 5 ? readUint32BE(this.pending, 1) : 0;
      if (this.pending.length < 5 || this.pending.length < 5 + length) {
        throw new Error('Helper stream ended with a truncated frame; the remote helper did not close cleanly.');
      }
      return this.push(new Uint8Array(0));
    }
    return [];
  }
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint64BE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

function writeUint64BE(bytes: Uint8Array, offset: number, value: bigint): void {
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

/** Canonical, optimistic-concurrency-safe idempotency hash for an argv request. */
export function computeRequestHash(argv: readonly string[], cwd: string | undefined, mode: 'pipe' | 'pty'): string {
  const canonical = JSON.stringify({ argv: [...argv], cwd: cwd ?? null, mode });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function isValidRequestHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
