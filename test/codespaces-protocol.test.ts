import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HELPER_PROTOCOL_VERSION,
  HelperFrameDecoder,
  HelperFrameType,
  MAX_HELPER_FRAME_PAYLOAD,
  OutputStream,
  computeRequestHash,
  decodeFramedJson,
  decodeOutputEvent,
  encodeFrame,
  encodeOutputEvent,
  isValidRequestHash,
} from '../src/codespaces-protocol.js';

test('frame round-trip preserves every byte for binary payloads', () => {
  for (const payload of [new Uint8Array(0), new Uint8Array([0, 255, 1, 128]), new Uint8Array(4096).fill(7)]) {
    const frame = encodeFrame(HelperFrameType.output, payload);
    assert.equal(frame[0], HelperFrameType.output);
    const length = (frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4];
    assert.equal(length, payload.length);
    assert.deepEqual([...frame.subarray(5)], [...payload]);
  }
});

test('the incremental decoder reassembles frames split across arbitrary chunk boundaries', () => {
  const frames = [
    encodeFrame(HelperFrameType.hello, new Uint8Array([1, 2])),
    encodeFrame(HelperFrameType.exit, new Uint8Array([3, 4, 5])),
    encodeFrame(HelperFrameType.cancelVerified, new Uint8Array([6])),
    encodeFrame(HelperFrameType.started, new Uint8Array([9, 9, 9, 9, 9])),
  ];
  const stream = new Uint8Array(frames.reduce((size, frame) => size + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { stream.set(frame, offset); offset += frame.length; }
  for (let chunkSize = 1; chunkSize <= 9; chunkSize += 1) {
    const decoder = new HelperFrameDecoder();
    const collected: number[] = [];
    for (let start = 0; start < stream.length; start += chunkSize) {
      const next = decoder.push(stream.subarray(start, Math.min(start + chunkSize, stream.length)));
      for (const frame of next) collected.push(frame.type);
    }
    assert.deepEqual(collected, [HelperFrameType.hello, HelperFrameType.exit, HelperFrameType.cancelVerified, HelperFrameType.started], `chunk size ${chunkSize}`);
  }
});

test('the decoder rejects an oversized length and a length built from truncated bytes', () => {
  const decoder = new HelperFrameDecoder();
  const oversized = new Uint8Array(5);
  oversized[0] = HelperFrameType.output;
  oversized[2] = (MAX_HELPER_FRAME_PAYLOAD + 1) >>> 16;
  oversized[4] = (MAX_HELPER_FRAME_PAYLOAD + 1) & 0xff;
  assert.throws(() => decoder.push(oversized), /bounded maximum/);
  const stillPartial = new HelperFrameDecoder();
  assert.deepEqual(stillPartial.push(new Uint8Array([HelperFrameType.output, 0, 0, 0])), []);
  assert.deepEqual(stillPartial.push(new Uint8Array([4, 65, 66])), []);
  assert.throws(() => stillPartial.flush(), /truncated/);
});

test('encodeFrame rejects out-of-range frame types and oversized payloads', () => {
  assert.throws(() => encodeFrame(256, new Uint8Array(0)), /type/);
  assert.throws(() => encodeFrame(-1, new Uint8Array(0)), /type/);
  assert.throws(() => encodeFrame(HelperFrameType.output, new Uint8Array(MAX_HELPER_FRAME_PAYLOAD + 1)), /oversized/);
});

test('output events carry a durable 64-bit byte offset and exact stream bytes', () => {
  const payload = encodeOutputEvent(OutputStream.stderr, 4097n, new Uint8Array([0, 1, 255]));
  const decoded = decodeOutputEvent(payload);
  assert.equal(decoded.stream, 'stderr');
  assert.equal(decoded.offset, 4097n);
  assert.deepEqual([...decoded.bytes], [0, 1, 255]);
  assert.throws(() => decodeOutputEvent(new Uint8Array([255])), /offset/);
});

test('JSON frames reject malformed or unbounded payloads', () => {
  const json = decodeFramedJson<{ protocol: number }>(encodeFrame(HelperFrameType.helloOk, new TextEncoder().encode('{"protocol":1}')).subarray(5));
  assert.equal(json.protocol, HELPER_PROTOCOL_VERSION);
  assert.throws(() => decodeFramedJson(encodeFrame(HelperFrameType.helloOk, new TextEncoder().encode('{broken')).subarray(5)), /invalid JSON/);
});

test('the request hash is a stable syntactically valid SHA-256 and differs per argv', () => {
  const argv: readonly [string, ...string[]] = ['echo', 'a b', '', 'Ünicode\tline'];
  const hash = computeRequestHash(argv, '/workspaces/project', 'pipe');
  assert.equal(isValidRequestHash(hash), true);
  assert.equal(computeRequestHash(argv, '/workspaces/project', 'pipe'), hash);
  assert.notEqual(computeRequestHash(['echo', 'a b'], '/workspaces/project', 'pipe'), hash);
  assert.notEqual(computeRequestHash(argv, '/workspaces/other', 'pipe'), hash);
  assert.equal(isValidRequestHash('not-a-hash'), false);
});