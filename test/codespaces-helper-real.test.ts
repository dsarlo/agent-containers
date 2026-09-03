import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir, access } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_ID, FIXTURE_ARM64, FIXTURE_X64, WORKSPACE_ID } from './transport-fixtures.js';
import {
  RealHelperProcess, commandDir, createRealHelperSpawner, helperDataRoot, killSpawnedRelays, realBootstrapRunner,
  realHelperBinaryPath, reassembleOutput, runRealHandshake,
} from './real-helper-harness.js';
import { HelperFrameType } from '../src/codespaces-protocol.js';
import { executeRemoteCommand } from '../src/codespaces-transport.js';
import { loadCommandStatus } from '../src/codespaces-command.js';
import { transportConfigFixture, transportFixture } from './transport-fixtures.js';
import type { CommandEvent } from '../src/types.js';

const BIN = realHelperBinaryPath();

function skipIfUnsupported(t: TestContext): boolean {
  if (!BIN) {
    t.skip('the real helper binary harness is only supported on linux-x64/arm64');
    return true;
  }
  return false;
}

function groupKill(dataDir: string, workspaceId: string, commandId: string): void {
  try {
    const content = JSON.parse(requireF(dataDir, workspaceId, commandId, 'command.json'));
    if (typeof content.pgid === 'number' && content.pgid > 1) {
      process.kill(-content.pgid, 'SIGKILL');
    }
  } catch {
    /* nothing recorded to reap */
  }
}

function requireF(dataDir: string, workspaceId: string, commandId: string, file: string): string {
  return readFileSync(join(commandDir(dataDir, workspaceId, commandId), file), 'utf8');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function collectUntilExit(client: RealHelperProcess, timeoutMs = 10000): Promise<Array<{ kind: string; [key: string]: unknown }>> {
  const seen: Array<{ kind: string; [key: string]: unknown }> = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await client.nextTyped();
    if (event === null) break;
    seen.push(event);
    if (event.kind === 'exit') return seen;
  }
  throw new Error(`real helper session ended without an exit event (saw ${seen.map((e) => e.kind).join(',')})`);
}

/** Collect frames until a terminal outcome (exit/cancel-verified/cancel-unknown/
 * error) or stream close arrives. */
async function collectTerminal(client: RealHelperProcess, timeoutMs = 15000): Promise<Array<{ kind: string; [key: string]: unknown }>> {
  const seen: Array<{ kind: string; [key: string]: unknown }> = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await client.nextTyped();
    if (event === null) break;
    seen.push(event);
    if (['exit', 'cancel-verified', 'cancel-unknown', 'error'].includes(event.kind)) return seen;
  }
  throw new Error(`real helper session ended without a terminal outcome (saw ${seen.map((e) => e.kind).join(',')})`);
}

test('real helper binary: hello announces the compile-time architecture (N1)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(bin, data);
  try {
    const hello = await client.autoHello();
    assert.equal(hello.protocol, 1);
    assert.equal(hello.helperArch, process.arch === 'arm64' ? 'aarch64' : 'x86_64');
  } finally {
    client.kill();
  }
});

test('real helper binary: the handshake subcommand matches the package format (N1/N2)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const output = await runRealHandshake(bin);
  const expectedArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  assert.match(output, /^agent-containers-helper v0\.1\.0 protocol=1 arch=(x86_64|aarch64) boot=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(output, new RegExp(`arch=${expectedArch}`));
  void data;
});

test('real helper never durably retains output that may contain a remote environment secret (SEC-1)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const secret = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz123456';
  const client = new RealHelperProcess(bin, data, { AC_TEST_SECRET: secret });
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-secret-output', workspace_id: WORKSPACE_ID,
      argv: ['printenv', 'AC_TEST_SECRET'], mode: 'pipe', cwd: null,
    });
    const events = await collectUntilExit(client);
    assert.equal(reassembleOutput(events, 'stdout').toString(), `${secret}\n`);
    const files = await readdir(commandDir(data, WORKSPACE_ID, COMMAND_ID));
    const contents = await Promise.all(files.map((file) => readFile(join(commandDir(data, WORKSPACE_ID, COMMAND_ID), file), 'utf8')));
    assert.ok(contents.every((content) => !content.includes(secret)), 'remote command records must never retain secret-bearing output');
  } finally {
    groupKill(data, WORKSPACE_ID, COMMAND_ID);
    client.kill();
  }
});

test('real helper binary: execute → disconnect → attach preserves exact exit status without retaining output (B2/SEC-1)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const first = new RealHelperProcess(bin, data);
  try {
    await first.autoHello();
    first.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-resume', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'printf 12345; sleep 1; printf 67890; exit 42'], mode: 'pipe', cwd: null,
    });
    const begun = await first.until((e) => e.kind === 'output', 5000);
    assert.equal(String.fromCharCode(...(begun.find((e) => e.kind === 'output') as unknown as { bytes: Uint8Array }).bytes), '12345');
    /* abrupt transport half-close; the owning helper keeps the child durable */
    first.endStdin();
    await sleep(80);

    const attach = new RealHelperProcess(bin, data);
    try {
      await attach.autoHello();
      attach.writeFrame(HelperFrameType.attach, {
        command_id: COMMAND_ID, request_hash: 'h-resume', workspace_id: WORKSPACE_ID,
        stdout_offset: '5', stderr_offset: '0', terminal_offset: '0',
      });
      const events = await collectUntilExit(attach);
      assert.equal(reassembleOutput(events, 'stdout').toString(), '', 'attach must not replay untrusted durable output');
      const exit = events.find((e) => e.kind === 'exit') as unknown as { code: number } | undefined;
      assert.ok(exit, 'attach must deliver an exit event');
      assert.equal(exit.code, 42, 'attach must deliver the exact retained exit status');
    } finally {
      attach.kill();
    }

    const status = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'status.json'));
    assert.equal(status.state, 'exited');
    assert.equal(status.exit_code, 42);
    assert.deepEqual(readdirSyncWithin(data, WORKSPACE_ID, COMMAND_ID).sort(), ['command.json', 'helper.json', 'status.json']);
    const helperJson = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'helper.json'));
    assert.equal(helperJson.protocol, 1);
    assert.match(helperJson.arch, /^(x86_64|aarch64)$/);
    assert.equal(helperJson.version, '0.1.0');
  } finally {
    groupKill(data, WORKSPACE_ID, COMMAND_ID);
    first.kill();
  }
});

test('real helper binary: PTY mode produces one merged terminal stream with \\r\\n translation and honors resize (B5)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(bin, data);
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-pty', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'printf "before\\n"; sleep 0.6; stty size; sleep 0.3; printf "after\\n"'], mode: 'pty', cwd: null, cols: 120, rows: 32,
    });
    let resized = false;
    const events = [];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const event = await client.nextTyped();
      if (event === null) break;
      events.push(event);
      if (event.kind === 'output' && String.fromCharCode(...(event as unknown as { bytes: Uint8Array }).bytes).includes('before') && !resized) {
        resized = true;
        client.writeFrame(HelperFrameType.resize, { command_id: COMMAND_ID, cols: 100, rows: 40 });
      }
      if (event.kind === 'exit') break;
    }
    const terminal = reassembleOutput(events, 'terminal').toString();
    const stdoutCount = events.filter((e) => e.kind === 'output' && (e as unknown as { stream: string }).stream === 'stdout').length;
    const stderrCount = events.filter((e) => e.kind === 'output' && (e as unknown as { stream: string }).stream === 'stderr').length;
    assert.equal(stdoutCount + stderrCount, 0, 'PTY output must be a single merged terminal stream, never separate stdout/stderr');
    assert.match(terminal, /before\r\n/, 'the merged terminal stream must carry \\r\\n translation');
    assert.match(terminal, /40 100/, 'twsize(100x40) must be reflected by the child stty size');
    const status = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'status.json'));
    assert.equal(status.state, 'exited');
    assert.equal(readdirSyncWithin(data, WORKSPACE_ID, COMMAND_ID).includes('terminal.log'), false, 'PTY output must not persist after the session ends');
  } finally {
    groupKill(data, WORKSPACE_ID, COMMAND_ID);
    client.endStdin();
    await sleep(100);
    client.kill();
  }
});

test('real helper binary: explicit stdin half-close lets cat complete without killing the child (B4)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(bin, data);
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-cat', workspace_id: WORKSPACE_ID, argv: ['cat'], mode: 'pipe', cwd: null,
    });
    await client.until((e) => e.kind === 'started', 5000);
    client.sendStdin(new TextEncoder().encode('hello world\n'));
    client.sendStdinEof({ command_id: COMMAND_ID });
    const events = await collectUntilExit(client);
    assert.equal(reassembleOutput(events, 'stdout').toString(), 'hello world\n', 'cat must receive stdin and echo it byte-identical');
    const exit = events.find((e) => e.kind === 'exit') as unknown as { code: number } | undefined;
    assert.ok(exit);
    assert.equal(exit.code, 0);
  } finally {
    client.endStdin();
    await sleep(50);
    client.kill();
  }
});

test('real helper binary: transport EOF leaves the child running and the durable record running; cancel verified only after the owning server reaps (B4/B3)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const exec = new RealHelperProcess(bin, data);
  try {
    await exec.autoHello();
    exec.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-live', workspace_id: WORKSPACE_ID, argv: ['sh', '-c', 'printf x; sleep 30'], mode: 'pipe', cwd: null,
    });
    await exec.until((e) => e.kind === 'output', 5000);
    exec.endStdin(); /* transport loss: the owning helper survives in orphan mode */
    await sleep(120);
    let status = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'status.json'));
    const command = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'command.json'));
    assert.equal(status.state, 'running', 'abrupt stream close must leave the durable command record running');
    assert.ok(command.pgid > 1, 'the durable record must carry the owning process group');
    let alive = true;
    try { process.kill(-command.pgid, 0); } catch { alive = false; }
    assert.ok(alive, 'abrupt transport loss must NOT SIGKILL the child process group');

    const cancel = new RealHelperProcess(bin, data);
    try {
      await cancel.autoHello();
      cancel.writeFrame(HelperFrameType.cancel, { command_id: COMMAND_ID, request_hash: 'h-live', workspace_id: WORKSPACE_ID, grace_ms: 4000 });
      const events = await collectTerminal(cancel);
      assert.ok(events.some((e) => e.kind === 'cancel-verified'), `expected verified cancel, got ${events.map((e) => e.kind).join(',')}`);
    } finally {
      cancel.kill();
    }
    status = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'status.json'));
    assert.equal(status.state, 'cancelled', 'cancel is only recorded after the owning server observed the reap');
    alive = true;
    try { process.kill(-command.pgid, 0); } catch { alive = false; }
    assert.equal(alive, false, 'verified cancel must reap the process group');
  } finally {
    groupKill(data, WORKSPACE_ID, COMMAND_ID);
    exec.kill();
  }
});

test('real helper binary: a signal-ignoring child yields cancel-unknown, never cancelled (B3)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const exec = new RealHelperProcess(bin, data);
  try {
    await exec.autoHello();
    exec.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-trap', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'trap "" TERM; printf x; while :; do sleep 1; done'], mode: 'pipe', cwd: null,
    });
    await exec.until((e) => e.kind === 'output', 5000);
    exec.endStdin();
    await sleep(120);

    const cancel = new RealHelperProcess(bin, data);
    try {
      await cancel.autoHello();
      cancel.writeFrame(HelperFrameType.cancel, { command_id: COMMAND_ID, request_hash: 'h-trap', workspace_id: WORKSPACE_ID, grace_ms: 1200 });
      const events = await collectTerminal(cancel);
      assert.ok(events.some((e) => e.kind === 'cancel-unknown'), `expected an explicit cancel-unknown, got ${events.map((e) => e.kind).join(',')}`);
      assert.ok(!events.some((e) => e.kind === 'cancel-verified'), 'cancel must never claim success without observed reap');
    } finally {
      cancel.kill();
    }
    const status = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'status.json'));
    assert.equal(status.state, 'running', 'a cancel-unknown must never fabricate a cancelled record');
  } finally {
    groupKill(data, WORKSPACE_ID, COMMAND_ID);
    exec.kill();
  }
});

test('real helper binary: a stdout-emitting child that reads stdin slowly does not deadlock (B6)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(bin, data);
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-slow', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'while IFS= read -r line; do echo ">>$line"; sleep 0.02; done'], mode: 'pipe', cwd: null,
    });
    await client.until((e) => e.kind === 'started', 5000);
    let payload = '';
    for (let index = 0; index < 150; index += 1) payload += `line${index}\n`;
    client.sendStdin(new TextEncoder().encode(payload), 100);
    client.sendStdinEof({ command_id: COMMAND_ID });
    const events = await collectUntilExit(client, 20000);
    const echoed = reassembleOutput(events, 'stdout').toString();
    assert.equal((echoed.match(/>>/g) ?? []).length, 150, 'every line must be echoed back (no pipe-mode stdin/stdout deadlock)');
  } finally {
    client.endStdin();
    await sleep(50);
    client.kill();
  }
});

test('real helper binary: empty argv tokens flow end to end with no deadlock (N3)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(bin, data);
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-empty', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'printf "<%s>" "$1"', 'x', ''], mode: 'pipe', cwd: null,
    });
    const events = await collectUntilExit(client);
    assert.equal(reassembleOutput(events, 'stdout').toString(), '<>', 'an empty argv token must be preserved and passed to the remote child');
  } finally {
    client.endStdin();
    await sleep(50);
    client.kill();
  }
});

test('real helper binary: credential-shaped argv is hashed in durable command.json (L2)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(BIN as string, data);
  const credential = 'ghp_012345678901234567890123456789012345';
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-redaction', workspace_id: WORKSPACE_ID,
      argv: ['printf', '%s', credential], mode: 'pipe', cwd: null,
    });
    await collectUntilExit(client);
    const record = requireF(data, WORKSPACE_ID, COMMAND_ID, 'command.json');
    assert.doesNotMatch(record, new RegExp(credential));
    assert.match(record, /redacted-fnv1a64-[0-9a-f]{16}/);
  } finally {
    client.endStdin();
    client.kill();
  }
});

test('real helper binary: stdin beyond the bounded queue reports an explicit error (L4)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(BIN as string, data);
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-stdin-overflow', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'sleep 10'], mode: 'pipe', cwd: null,
    });
    await client.until((event) => event.kind === 'started', 5000);
    client.sendStdin(new Uint8Array(5 * 1024 * 1024).fill(65), 1024 * 1024);
    const events = await collectTerminal(client);
    const overflow = events.find((event) => event.kind === 'error');
    assert.equal(overflow?.message, 'stdin-overflow');
  } finally {
    groupKill(data, WORKSPACE_ID, COMMAND_ID);
    client.endStdin();
    client.kill();
  }
});

test('real helper binary: stdin overflow is caller-visible and never reconnects to report a truncated-input success (L4)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const data = await helperDataRoot();
  try {
    const fixture = await transportFixture({
      spawner: createRealHelperSpawner(BIN as string, data),
      runner: realBootstrapRunner(BIN as string, digestOf(process.arch === 'arm64' ? FIXTURE_ARM64 : FIXTURE_X64)),
      reconnectBudgetMs: 5_000,
    });
    async function* oversizedInput() {
      const bytes = new Uint8Array(64 * 1024).fill(65);
      for (let index = 0; index < 80; index += 1) yield bytes;
    }
    await assert.rejects(async () => {
      for await (const event of executeRemoteCommand(fixture.deps, {
        commandId: COMMAND_ID, argv: ['sh', '-c', 'sleep 10'], mode: 'pipe', stdin: 'stream', stdinSource: oversizedInput(),
      })) void event;
    }, /bounded queue/);
    assert.equal((await loadCommandStatus(fixture.stateDir, COMMAND_ID))?.state, 'outcome-unknown');
  } finally {
    killSpawnedRelays();
  }
});

test('real helper binary: byte retention rejects evicted offsets and resumes its deterministic tail (N5)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const data = await helperDataRoot();
  const client = new RealHelperProcess(BIN as string, data);
  try {
    await client.autoHello();
    client.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-retention', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'printf 1234567890'], mode: 'pipe', cwd: null, retention_bytes: 4,
    });
    await collectUntilExit(client);
    assert.equal(requireF(data, WORKSPACE_ID, COMMAND_ID, 'stdout.log'), '7890');
    const attach = new RealHelperProcess(BIN as string, data);
    try {
      await attach.autoHello();
      attach.writeFrame(HelperFrameType.attach, { command_id: COMMAND_ID, request_hash: 'h-retention', workspace_id: WORKSPACE_ID, stdout_offset: '0', stderr_offset: '0', terminal_offset: '0' });
      const rejected = await attach.nextTyped();
      assert.equal(rejected?.kind, 'rejected');
      assert.equal(rejected?.reason, 'attach-offset-beyond-retention');
    } finally { attach.kill(); }
    const resumed = new RealHelperProcess(BIN as string, data);
    try {
      await resumed.autoHello();
      resumed.writeFrame(HelperFrameType.attach, { command_id: COMMAND_ID, request_hash: 'h-retention', workspace_id: WORKSPACE_ID, stdout_offset: '6', stderr_offset: '0', terminal_offset: '0' });
      const events = await collectUntilExit(resumed);
      assert.equal(reassembleOutput(events, 'stdout').toString(), '7890');
    } finally { resumed.kill(); }
  } finally { client.kill(); }
});

test('real helper binary: a running attach fails closed when retention evicts its live continuation (R4)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const data = await helperDataRoot();
  const first = new RealHelperProcess(BIN as string, data);
  try {
    await first.autoHello();
    first.writeFrame(HelperFrameType.exec, {
      command_id: COMMAND_ID, request_hash: 'h-retention-live-tail', workspace_id: WORKSPACE_ID,
      argv: ['sh', '-c', 'printf 1234567890; sleep 3; printf ABCDEF'], mode: 'pipe', cwd: null, retention_bytes: 4,
    });
    await first.until((event) => event.kind === 'output', 5000);
    first.endStdin();
    await sleep(80);

    const attach = new RealHelperProcess(BIN as string, data);
    try {
      await attach.autoHello();
      attach.writeFrame(HelperFrameType.attach, {
        command_id: COMMAND_ID, request_hash: 'h-retention-live-tail', workspace_id: WORKSPACE_ID,
        stdout_offset: '10', stderr_offset: '0', terminal_offset: '0',
      });
      const events = await collectTerminal(attach, 8000);
      assert.equal(reassembleOutput(events, 'stdout').toString(), '', 'the attach must not claim evicted continuation bytes were delivered');
      assert.equal(events.some((event) => event.kind === 'exit'), false, 'an attach with an evicted continuation must not exit cleanly');
      const failure = events.find((event) => event.kind === 'error');
      assert.equal(failure?.message, 'attach-output-lost');
    } finally { attach.kill(); }

    const status = JSON.parse(requireF(data, WORKSPACE_ID, COMMAND_ID, 'status.json'));
    assert.equal(status.stdout_offset, 16, 'the durable logical end must include the evicted continuation');
  } finally {
    groupKill(data, WORKSPACE_ID, COMMAND_ID);
    first.kill();
  }
});

test('real helper binary: a live chunk larger than retention reaches executeRemoteCommand intact and exits durably (N5)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const data = await helperDataRoot();
  try {
    const config = transportConfigFixture();
    config.backends.codespaces.transport.remoteLogBytesPerStream = 4;
    const fixture = await transportFixture({
      config,
      spawner: createRealHelperSpawner(BIN as string, data),
      runner: realBootstrapRunner(BIN as string, digestOf(process.arch === 'arm64' ? FIXTURE_ARM64 : FIXTURE_X64)),
    });
    const events: CommandEvent[] = [];
    for await (const event of executeRemoteCommand(fixture.deps, {
      commandId: COMMAND_ID, argv: ['sh', '-c', 'printf 1234567890'], mode: 'pipe', stdin: 'closed',
    })) events.push(event);
    assert.equal(Buffer.concat(events.filter((event) => event.type === 'stdout').map((event) => Buffer.from((event as { bytes: Uint8Array }).bytes))).toString(), '1234567890');
    assert.deepEqual(events.at(-1), { type: 'exit', commandId: COMMAND_ID, code: 0 });
    const status = await loadCommandStatus(fixture.stateDir, COMMAND_ID);
    assert.equal(status?.state, 'exited');
    assert.equal(status?.exitCode, 0);
  } finally {
    killSpawnedRelays();
  }
});

test('real helper binary: execute through the full backend transport yields the exact corpus output and exit (N2)', async (t: TestContext) => {
  if (skipIfUnsupported(t)) return;
  const bin = BIN as string;
  const data = await helperDataRoot();
  try {
    const fixture = await transportFixture({
      spawner: createRealHelperSpawner(bin, data),
      runner: realBootstrapRunner(bin, digestOf(process.arch === 'arm64' ? FIXTURE_ARM64 : FIXTURE_X64)),
    });
    const events: CommandEvent[] = [];
    const argv = ['sh', '-c', 'printf "hello-%s" "$1"; exit 5', 'x', 'world'] as unknown as [string, ...string[]];
    for await (const event of executeRemoteCommand(fixture.deps, { commandId: COMMAND_ID, argv, mode: 'pipe', stdin: 'closed' })) events.push(event);
    const terminal = events.at(-1);
    assert.deepEqual(terminal, { type: 'exit', commandId: COMMAND_ID, code: 5 });
    const stdout = Buffer.concat(events.filter((e) => e.type === 'stdout').map((e) => Buffer.from((e as { bytes: Uint8Array }).bytes))).toString();
    assert.equal(stdout, 'hello-world');
  } finally {
    killSpawnedRelays();
  }
});

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readdirSyncWithin(dataDir: string, workspaceId: string, commandId: string): string[] {
  return readdirSync(commandDir(dataDir, workspaceId, commandId));
}

void readFile;
void readdir;
void access;
