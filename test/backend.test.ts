import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalExecutionBackend, resolveExecutionBackend } from '../src/backend.js';

test('local execution adapter dispatches lifecycle calls and preserves command argv', async () => {
  const calls: unknown[][] = [];
  const backend = createLocalExecutionBackend({
    create: async (request) => { calls.push(['create', request]); return { kind: 'local' }; },
    execute: async function* (_handle, request) { calls.push(['execute', request]); yield { type: 'exit', commandId: request.commandId, code: 0 }; },
    remove: async (handle) => { calls.push(['remove', handle]); },
  });

  const handle = await backend.create({ name: 'golden', backend: 'local' });
  const events = [];
  for await (const event of backend.execute(handle, { commandId: 'cmd-1', argv: ['printf', '%s', 'two words'] })) events.push(event);
  await backend.remove(handle);

  assert.deepEqual(calls, [
    ['create', { name: 'golden', backend: 'local' }],
    ['execute', { commandId: 'cmd-1', argv: ['printf', '%s', 'two words'] }],
    ['remove', { kind: 'local' }],
  ]);
  assert.deepEqual(events, [{ type: 'exit', commandId: 'cmd-1', code: 0 }]);
  await assert.rejects(() => resolveExecutionBackend('codespaces').create({ name: 'no-local-action', backend: 'codespaces' }), /phase-gated/);
});
