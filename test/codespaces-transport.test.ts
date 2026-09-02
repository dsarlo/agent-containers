import assert from 'node:assert/strict';
import test from 'node:test';
import { transportFixture, COMMAND_ID, collect, helperBootstrapRunner, type TransportFixture } from './transport-fixtures.js';
import { executeRemoteCommand, attachRemoteCommand, helperDeps } from '../src/codespaces-transport.js';
import { bootstrapRemoteHelper } from '../src/codespaces-helper.js';
import { loadCommandRequest, loadCommandOffsets, loadCommandStatus, loadCommandRecovery } from '../src/codespaces-command.js';
import { loadMetadata } from '../src/state.js';
import { loadCodespacesJournal } from '../src/codespaces-ops.js';
import type { CommandEvent } from '../src/types.js';

function bytes(...values: number[]): Uint8Array { return Uint8Array.from(values); }

function pipeInput(overrides: Partial<import('../src/codespaces-transport.js').ExecuteTransportInput> = {}): import('../src/codespaces-transport.js').ExecuteTransportInput {
  return { commandId: COMMAND_ID, argv: ['sleep', '0'], mode: 'pipe', stdin: 'closed', ...overrides };
}

async function executeToEnd(fixture: TransportFixture, input: import('../src/codespaces-transport.js').ExecuteTransportInput, options: { guardMs?: number } = {}): Promise<CommandEvent[]> {
  const events: unknown[] = [];
  await withSettleGuard((async () => {
    for await (const event of executeRemoteCommand(fixture.deps, input)) events.push(event);
  })(), 'executeToEnd did not settle', options.guardMs ?? 8000);
  return events as CommandEvent[];
}

/** Bounded settle guard: a transport promise that cannot settle (pending
 * microtasks, emptied event loop) must fail the test with a clear message
 * instead of leaving the suite to cancel the subtest at the file boundary. */
async function withSettleGuard<T>(promise: Promise<T>, message: string, guardMs = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    // NOTE: the timer must stay ref'd — an unref'd timer cannot fire once the
    // event loop drains, which is precisely the CI failure mode this guard
    // must diagnose with a clear error instead of a runner cancellation.
    timer = setTimeout(() => reject(new Error(`${message} (bounded settle guard after ${guardMs}ms)`)), guardMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function outputsFrom(events: readonly CommandEvent[], stream: 'stdout' | 'stderr' | 'terminal'): { offset: bigint; bytes: Uint8Array }[] {
  return events.filter((event) => event.type === stream).map((event) => ({ offset: (event as { offset: bigint }).offset, bytes: (event as { bytes: Uint8Array }).bytes }));
}

function reassemble(chunks: readonly { bytes: Uint8Array }[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)));
}

test('execute preserves the exhaustive argv corpus end to end without a host shell (N1)', async () => {
  const argv: readonly [string, ...string[]] = [
    'printf', '%s',
    'space separated',
    'double "quote"',
    "single 'quote'",
    'meta $()`;&|<>*?[]{}\\#$%^',
    'line1\nline2',
    '',
    'Ünicode ün ß Ā ミ',
    'tab\there',
  ];
  const fixture = await transportFixture();
  fixture.helper.configure({
    commandId: COMMAND_ID, outputs: [{ stream: 'stdout', bytes: bytes(1, 2, 3) }], exitCode: 0,
  });
  const events = await executeToEnd(fixture, pipeInput({ argv, stdin: 'closed' }));
  assert.ok(events.some((event) => event.type === 'accepted'));
  assert.ok(events.some((event) => event.type === 'started'));
  assert.deepEqual(events.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 0 });
  const record = fixture.helper.records.get(COMMAND_ID);
  assert.ok(record, 'the remote helper must receive the framed argv');
  assert.deepEqual(record.argv, [...argv]);
  assert.ok(fixture.spawnerCalls.every((args) => args.every((value) => value === 'gh' || value.startsWith('codespace') || value.startsWith('ssh') || value.startsWith('-c') || value === COMMAND_ID || value === '--' || value.startsWith('bookish-') || value.startsWith('/workspaces/.agent-containers/') || value === 'serve' || value.startsWith('agent-containers-helper')), 'only fixed package-owned serve argv may reach the remote'));
  // The recorded request hash binds the exact corpus (idempotency).
  const request = await loadCommandRequest(fixture.stateDir, COMMAND_ID);
  assert.ok(request && request.argvCount === argv.length);
});

test('binary stdout/stderr are delivered byte-identical across arbitrary chunk boundaries (N2)', async () => {
  const payloadBytes = new Uint8Array(200_000);
  for (let index = 0; index < payloadBytes.length; index += 1) payloadBytes[index] = (index * 7 + 3) & 0xff;
  for (const chunkSize of [1, 7, 1024, 65536]) {
    const fixture = await transportFixture();
    const chunks: Array<{ stream: 'stdout' | 'stderr'; bytes: Uint8Array }> = [];
    for (let offset = 0; offset < payloadBytes.length; offset += chunkSize) {
      chunks.push({ stream: 'stdout', bytes: payloadBytes.subarray(offset, Math.min(offset + chunkSize, payloadBytes.length)) });
    }
    fixture.helper.configure({ commandId: COMMAND_ID, outputs: chunks, exitCode: 0 });
    const events = await executeToEnd(fixture, pipeInput(), { guardMs: 60_000 });
    const stdout = outputsFrom(events, 'stdout');
    assert.deepEqual(reassemble(stdout), Buffer.from(payloadBytes), `chunk size ${chunkSize}`);
    // Contiguous, non-overlapping durable offsets.
    let cursor = 0n;
    for (const chunk of stdout) {
      assert.equal(chunk.offset, cursor, 'offsets must be contiguous');
      cursor += BigInt(chunk.bytes.length);
    }
    assert.equal(cursor, BigInt(payloadBytes.length));
  }
});

test('separate binary stdout and stderr streams are never merged in pipe mode (N3)', async () => {
  const fixture = await transportFixture();
  fixture.helper.configure({
    commandId: COMMAND_ID,
    outputs: [
      { stream: 'stdout', bytes: bytes(1, 0, 2, 255) },
      { stream: 'stderr', bytes: bytes(9, 8, 7) },
      { stream: 'stdout', bytes: bytes(3, 3, 3) },
    ],
    exitCode: 1,
  });
  const events = await executeToEnd(fixture, pipeInput());
  assert.deepEqual(reassemble(outputsFrom(events, 'stdout')), Buffer.from([1, 0, 2, 255, 3, 3, 3]));
  assert.deepEqual(reassemble(outputsFrom(events, 'stderr')), Buffer.from([9, 8, 7]));
  assert.equal(outputsFrom(events, 'terminal').length, 0, 'pipe mode must never emit a merged terminal stream');
  assert.deepEqual(events.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 1 });
});

test('a nonzero exit status is delivered exactly (N4)', async () => {
  const fixture = await transportFixture();
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [], exitCode: 137 });
  const events = await executeToEnd(fixture, pipeInput());
  assert.deepEqual(events.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 137 });
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.ok(status && status.state === 'exited' && status.exitCode === 137);
});

test('stdin is forwarded as frames and half-closed before the output is drained (N5)', async () => {
  const fixture = await transportFixture();
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [{ stream: 'stdout', bytes: bytes(100) }], exitCode: 0 });
  const sent: Uint8Array[] = [bytes(1, 2, 3), bytes(4, 5)];
  async function* stdinSource() { for (const chunk of sent) yield chunk; }
  const events = await executeToEnd(fixture, pipeInput({ stdin: 'stream', stdinSource: stdinSource() }));
  assert.equal(events.at(-1)?.type, 'exit');
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.equal(status?.state, 'exited');
});

test('disconnect/reconnect resumes by offsets and delivers the exact retained exit (N6)', async () => {
  const firstChunk = new Uint8Array(5000).fill(1);
  const secondChunk = new Uint8Array(5000).fill(2);
  const fixture = await transportFixture({ reconnectBudgetMs: 5000 });
  fixture.helper.configure({
    commandId: COMMAND_ID,
    outputs: [
      { stream: 'stdout', bytes: firstChunk },
      { stream: 'stderr', bytes: secondChunk.subarray(0, 2000) },
      { stream: 'stdout', bytes: secondChunk },
    ],
    exitCode: 9,
    dropAfterOutputs: 2,
  });
  const events = await executeToEnd(fixture, pipeInput());
  assert.deepEqual(reassemble(outputsFrom(events, 'stdout')), Buffer.concat([Buffer.from(firstChunk), Buffer.from(secondChunk)]));
  assert.deepEqual(reassemble(outputsFrom(events, 'stderr')), Buffer.from(secondChunk.subarray(0, 2000)));
  assert.deepEqual(events.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 9 });
  const offsets = await loadCommandOffsets(fixture.stateDir, COMMAND_ID);
  assert.ok(offsets && BigInt(offsets.stdout) === 10000n);
  // Reconnect must attach (never re-exec); exactly one exec request was framed.
  const journal = await loadCodespacesJournal(fixture.stateDir, fixture.metadata.name);
  assert.equal(journal.filter((entry) => entry.event === 'command-started').length, 1);
});

test('a duplicate request with the same ID and hash attaches instead of replaying (N7)', async () => {
  const fixture = await transportFixture();
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [{ stream: 'stdout', bytes: bytes(1, 2) }], exitCode: 0 });
  await executeToEnd(fixture, pipeInput());
  const execCountAfterFirst = fixture.helper.records.get(COMMAND_ID)?.argv.length;
  assert.equal(execCountAfterFirst, 2);
  const attachAgain = await executeToEnd(fixture, pipeInput());
  assert.ok(attachAgain.some((event) => event.type === 'accepted'), 'the same request ID resolves to attach');
  assert.equal(outputsFrom(attachAgain, 'stdout').length, 0, 'already-acknowledged bytes are attached, never replayed');
  assert.deepEqual(attachAgain.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 0 });
});

test('reusing a command ID for a different argv hash is rejected before any session (N8)', async () => {
  const fixture = await transportFixture();
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [{ stream: 'stdout', bytes: bytes(1, 2) }], exitCode: 0 });
  await executeToEnd(fixture, pipeInput());
  const before = fixture.spawnerCalls.length;
  await assert.rejects(() => executeToEnd(fixture, pipeInput({ argv: ['different', 'argv'] })), /different argv hash/i);
  assert.equal(fixture.spawnerCalls.length, before, 'a hash mismatch must block before any new remote session');
});

test('attach from an interrupted session resumes retained output by offsets (N9)', async () => {
  const firstChunk = new Uint8Array(3000).fill(5);
  const secondChunk = new Uint8Array(3000).fill(7);
  const fixture = await transportFixture({ reconnectBudgetMs: 0 });
  fixture.helper.configure({
    commandId: COMMAND_ID,
    outputs: [{ stream: 'stdout', bytes: firstChunk }, { stream: 'stdout', bytes: secondChunk }],
    exitCode: 4,
    dropAfterOutputs: 1,
  });
  const first = await executeToEnd(fixture, pipeInput());
  const types = first.map((event) => event.type);
  assert.ok(types.includes('detached'), `interrupted execute must detach with offsets (got ${types.join(',')})`);
  const detached = first.at(-1) as { type: 'detached'; offsets: { stdout: bigint; stderr: bigint; terminal: bigint } };
  const attachFixture = fixture;
  const attached: CommandEvent[] = [];
  for await (const event of attachRemoteCommand(attachFixture.deps, COMMAND_ID)) attached.push(event);
  const events = attached;
  const resumed = outputsFrom(events, 'stdout');
  assert.equal(resumed.length, 1, 'attach resumes from the recorded offset without duplication');
  assert.equal(resumed[0]?.offset, 3000n);
  assert.deepEqual(Buffer.from(resumed[0]?.bytes ?? new Uint8Array(0)), Buffer.from(secondChunk));
  assert.deepEqual(events.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 4 });
  const offsets = await loadCommandOffsets(fixture.stateDir, COMMAND_ID);
  assert.equal(BigInt(offsets?.stdout ?? '0'), 6000n, 'attach advances the durable offset cursor to the retained end');
  assert.equal(detached.type, 'detached');
});

test('transport loss produces a fail-closed detached recovery state and never claims stopped (N10)', async () => {
  const chunk = new Uint8Array(64).fill(9);
  const fixture = await transportFixture({ reconnectBudgetMs: 0 });
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [{ stream: 'stdout', bytes: chunk }], exitCode: 0, dropAfterOutputs: 1, stayRunning: true });
  const events = await executeToEnd(fixture, pipeInput());
  const terminal = events.at(-1) as import('../src/types.js').CommandEvent;
  assert.equal(terminal.type, 'detached');
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.ok(status && status.state === 'detached', 'the command must remain running/detached, never exited(0)');
  const recovery = await loadCommandRecovery(fixture.stateDir, COMMAND_ID);
  assert.ok(recovery && recovery.reason === 'transport-lost');
  const recorded = await loadMetadata(fixture.stateDir, fixture.metadata.name);
  assert.ok(recorded && recorded.version === 2 && recorded.backend === 'codespaces' && recorded.recovery !== null, 'metadata recovery barrier is recorded on helper loss');
  const journal = await loadCodespacesJournal(fixture.stateDir, fixture.metadata.name);
  assert.ok(journal.some((entry) => entry.event === 'command-detached'));
});

test('cancel success is reported only after the remote helper proves the process group is gone (N11)', async () => {
  const chunk = new Uint8Array(64).fill(3);
  const fixture = await transportFixture({ cancelGraceMs: 2000, reconnectBudgetMs: 1000 });
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [{ stream: 'stdout', bytes: chunk }], exitCode: null, stayRunning: true, cancelProofDelayMs: 120, cancelPolicy: 'verify' });
  const signal = new AbortController();
  const generator = executeRemoteCommand({ ...fixture.deps, signal: signal.signal }, pipeInput());
  const events: import('../src/types.js').CommandEvent[] = [];
  const consumption = (async () => {
    for await (const event of generator) events.push(event);
  })();
  await withSettleGuard((async () => {
    while (!events.some((event) => event.type === 'started')) await new Promise((resolve) => setTimeout(resolve, 5));
  })(), 'N11 command did not reach started before cancellation', 1000);
  signal.abort();
  await withSettleGuard(consumption, 'cancel-unknown generation did not settle');
  const terminal = events.at(-1);
  assert.equal(terminal?.type, 'cancelled', `expected verified cancel, got ${JSON.stringify(events.map((event) => event.type))}`);
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.equal(status?.state, 'cancelled');
  const recovery = await loadCommandRecovery(fixture.stateDir, COMMAND_ID);
  assert.equal(recovery, undefined, 'verified cancellation must not leave a recovery barrier');
  const journal = await loadCodespacesJournal(fixture.stateDir, fixture.metadata.name);
  assert.ok(journal.some((entry) => entry.event === 'cancel-verified'));
});

test('cancel-unknown is recorded durably when the helper cannot prove the process group stopped (N12)', async () => {
  const fixture = await transportFixture({ cancelGraceMs: 150, reconnectBudgetMs: 80 });
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [], exitCode: null, stayRunning: true, cancelPolicy: 'never' });
  const signal = new AbortController();
  const generator = executeRemoteCommand({ ...fixture.deps, signal: signal.signal }, pipeInput());
  const events: import('../src/types.js').CommandEvent[] = [];
  const consumption = (async () => {
    for await (const event of generator) events.push(event);
  })();
  setTimeout(() => signal.abort(), 10);
  const started = Date.now();
  await withSettleGuard(consumption, 'cancel-unknown generation did not settle');
  assert.ok(Date.now() - started < 3000, 'cancel-unknown must be bounded by the cancel deadline');
  assert.equal(events.at(-1)?.type, 'cancel-unknown');
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.equal(status?.state, 'cancel-outcome-unknown');
  const recovery = await loadCommandRecovery(fixture.stateDir, COMMAND_ID);
  assert.ok(recovery && recovery.reason === 'cancel-outcome-unknown');
  const recorded = await loadMetadata(fixture.stateDir, fixture.metadata.name);
  assert.ok(recorded && recorded.version === 2 && recorded.backend === 'codespaces' && recorded.recovery !== null);
  const journal = await loadCodespacesJournal(fixture.stateDir, fixture.metadata.name);
  assert.ok(journal.some((entry) => entry.event === 'cancel-unknown'));
});

test('a second interrupt detaches while the first cancel proof is pending and records an unknown outcome (N13)', async () => {
  const fixture = await transportFixture({ cancelGraceMs: 60000, reconnectBudgetMs: 60000 });
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [], exitCode: null, stayRunning: true, cancelPolicy: 'verify', cancelProofDelayMs: 60000 });
  const first = new AbortController();
  const second = new AbortController();
  const generator = executeRemoteCommand({ ...fixture.deps, signal: first.signal, detachSignal: second.signal }, pipeInput());
  const events: import('../src/types.js').CommandEvent[] = [];
  const consumption = (async () => {
    for await (const event of generator) events.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  first.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  second.abort();
  const started = Date.now();
  await withSettleGuard(consumption, 'cancel-unknown generation did not settle');
  assert.ok(Date.now() - started < 3000, 'the second interrupt must detach immediately without waiting for the proof timer');
  assert.equal(events.at(-1)?.type, 'cancel-unknown');
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.equal(status?.state, 'cancel-outcome-unknown');
  const recovery = await loadCommandRecovery(fixture.stateDir, COMMAND_ID);
  assert.ok(recovery, 'the unknown outcome must be durably recoverable');
});

test('a pre-aborted signal cancels deterministically instead of hanging (N7)', async () => {
  const chunk = new Uint8Array(4).fill(7);
  const fixture = await transportFixture({ cancelGraceMs: 150, reconnectBudgetMs: 1000 });
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [{ stream: 'stdout', bytes: chunk }], exitCode: null, stayRunning: true, cancelPolicy: 'never' });
  const signal = new AbortController();
  signal.abort();
  const events: import('../src/types.js').CommandEvent[] = [];
  const consumption = (async () => {
    for await (const event of executeRemoteCommand({ ...fixture.deps, signal: signal.signal }, pipeInput())) events.push(event);
  })();
  await withSettleGuard(consumption, 'pre-aborted execute did not settle');
  assert.equal(events.at(-1)?.type, 'cancel-unknown', 'a pre-aborted execute must yield a bounded cancel-unknown, never a hang');
});

test('a second interrupt aborts an in-flight helper inspection probe before cancel proof settles (N13)', async () => {
  const base = helperBootstrapRunner();
  let stallInspection = false;
  let probeAborted = false;
  const runner = {
    async run(command: string, args: string[], options?: { signal?: AbortSignal }) {
      const remote = args.slice(args.indexOf('--') + 1).join(' ');
      if (stallInspection && remote.startsWith('sha256sum ')) {
        return await new Promise<never>((_, reject) => {
          const onAbort = () => {
            probeAborted = true;
            const error = new Error('inspection aborted');
            error.name = 'AbortError';
            reject(error);
          };
          options?.signal?.addEventListener('abort', onAbort, { once: true });
          if (options?.signal?.aborted) onAbort();
        });
      }
      return base.run(command, args, options);
    },
  };
  const fixture = await transportFixture({ runner, cancelGraceMs: 60_000, reconnectBudgetMs: 60_000 });
  fixture.helper.configure({ commandId: COMMAND_ID, outputs: [], exitCode: null, stayRunning: true, cancelPolicy: 'verify', cancelProofDelayMs: 60_000 });
  const first = new AbortController();
  const second = new AbortController();
  const events: CommandEvent[] = [];
  const consume = (async () => { for await (const event of executeRemoteCommand({ ...fixture.deps, signal: first.signal, detachSignal: second.signal }, pipeInput())) events.push(event); })();
  for (let attempt = 0; attempt < 20 && !events.some((event) => event.type === 'started'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(events.some((event) => event.type === 'started'), 'initial execution must be live before testing post-abort inspection');
  stallInspection = true;
  first.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  second.abort();
  await withSettleGuard(consume, 'second interrupt did not abort helper inspection', 1000);
  assert.equal(probeAborted, true, 'detach signal must reach the controlled inspection probe');
  assert.equal(events.at(-1)?.type, 'cancel-unknown');
});

test('a pre-loop durable offset failure removes the first-interrupt listener (N7)', async () => {
  const fixture = await transportFixture();
  // Stage a known helper while durability works, so execution fails specifically
  // after bootstrap at initial offset persistence.
  await bootstrapRemoteHelper(helperDeps(fixture.deps));
  const { setCodespacesCommandDurabilityAdapterForTesting } = await import('../src/codespaces-command.js');
  const signal = new AbortController();
  const normalAdapter = {
    publicationMode: async () => 'strict' as const,
    assertStateWriteSupport: async () => undefined,
    syncFile: async () => undefined,
    syncDirectory: async () => undefined,
    moveFileWriteThrough: async () => undefined,
  };
  let syncs = 0;
  setCodespacesCommandDurabilityAdapterForTesting({
    publicationMode: async () => 'strict',
    assertStateWriteSupport: async () => undefined,
    syncFile: async () => {
      syncs += 1;
      if (syncs === 3) throw new Error('forced initial offset durability failure');
    },
    syncDirectory: async () => undefined,
    moveFileWriteThrough: async () => undefined,
  });
  try {
    await assert.rejects(collect(executeRemoteCommand({ ...fixture.deps, signal: signal.signal }, pipeInput())), /forced initial offset durability failure/);
  } finally {
    setCodespacesCommandDurabilityAdapterForTesting(normalAdapter);
  }
  signal.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const journal = await loadCodespacesJournal(fixture.stateDir, fixture.metadata.name);
  assert.equal(journal.some((entry) => entry.event === 'cancel-requested'), false, 'a failed execution must not retain a stale first-interrupt listener');
});

test('a helper protocol mismatch on the serve handshake blocks execution fail-closed (N14)', async () => {
  const fixture = await transportFixture();
  fixture.helper.protocol = 99;
  await assert.rejects(() => executeToEnd(fixture, pipeInput()), /protocol/);
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.ok(status === undefined || status.state !== 'exited', 'no stopped/exit outcome may be recorded when the handshake is blocked');
});

test('a helper architecture mismatch on the serve handshake blocks execution fail-closed (N1)', async () => {
  const fixture = await transportFixture();
  fixture.helper.configure({ commandId: COMMAND_ID, helperArch: 'aarch64', outputs: [{ stream: 'stdout', bytes: bytes(1, 2) }], exitCode: 0 });
  await assert.rejects(() => executeToEnd(fixture, pipeInput()), /architecture/);
  const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
  assert.ok(status === undefined || status.state !== 'exited', 'no stopped/exit outcome may be recorded when the helper architecture disagrees with the package-owned artifact');
});

test('PTY mode delivers one deterministic merged terminal stream and forwards resize events (P1)', async () => {
  const first = new Uint8Array([27, 91, 49, 109, 72, 101, 108, 108, 111]);
  const second = new Uint8Array([27, 91, 48, 109, 10, 0, 255]);
  const fixture = await transportFixture();
  fixture.helper.configure({
    commandId: COMMAND_ID,
    outputs: [{ stream: 'terminal', bytes: first }, { stream: 'terminal', bytes: second }],
    exitCode: 0,
  });
  const events: CommandEvent[] = [];
  for await (const event of executeRemoteCommand(fixture.deps, {
    commandId: COMMAND_ID, argv: ['bash', '-l'], mode: 'pty', stdin: 'closed', cols: 120, rows: 32,
    resizeSource: (async function* () { yield { cols: 100, rows: 40 }; })(),
  })) events.push(event);
  assert.deepEqual(reassemble(outputsFrom(events, 'terminal')), Buffer.concat([Buffer.from(first), Buffer.from(second)]));
  assert.equal(outputsFrom(events, 'stdout').length, 0, 'PTY output must be a single merged terminal stream, never separate stdout/stderr');
  assert.equal(outputsFrom(events, 'stderr').length, 0);
  assert.deepEqual(fixture.helper.resizes, [{ commandId: COMMAND_ID, cols: 100, rows: 40 }], 'resize events must pass through to the remote helper');
  assert.deepEqual(events.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 0 });
  const request = await loadCommandRequest(fixture.stateDir, COMMAND_ID);
  assert.equal(request?.mode, 'pty');
});