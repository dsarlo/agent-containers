import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDevcontainerInvocation } from '../src/devcontainer.js';

test('Dev Containers invocation is direct argv on non-Windows platforms', () => {
  assert.deepEqual(resolveDevcontainerInvocation({ platform: 'linux' }), { command: 'devcontainer', prefixArgs: [] });
});

test('Windows runs the public Dev Containers JavaScript entry point through Node without cmd.exe', () => {
  const paths: string[][] = [];
  const invocation = resolveDevcontainerInvocation({
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    resolveCommand: () => 'C:\\Users\\agent\\AppData\\Roaming\\npm\\devcontainer.cmd',
    resolveModule(specifier, searchPaths) {
      assert.equal(specifier, '@devcontainers/cli/devcontainer.js');
      paths.push(searchPaths);
      return 'C:\\Users\\agent\\AppData\\Roaming\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js';
    },
  });
  assert.deepEqual(invocation, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    prefixArgs: ['C:\\Users\\agent\\AppData\\Roaming\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js'],
  });
  assert.equal(paths.length, 1);
  assert.equal(invocation.command.includes('cmd.exe'), false);
});

test('Windows derives the public CLI package location from the resolved PATH devcontainer.cmd', () => {
  const invocation = resolveDevcontainerInvocation({
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    resolveCommand: (command) => command === 'devcontainer.cmd' ? 'D:\\tools\\npm\\devcontainer.cmd' : undefined,
    resolveModule(specifier, paths) {
      assert.equal(specifier, '@devcontainers/cli/devcontainer.js');
      assert.deepEqual(paths[0], 'D:\\tools\\npm\\node_modules');
      return 'D:\\tools\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js';
    },
  });
  assert.deepEqual(invocation, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    prefixArgs: ['D:\\tools\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js'],
  });
});

test('Windows refuses lifecycle dispatch when no authoritative Dev Containers command resolver is available', () => {
  assert.throws(
    () => resolveDevcontainerInvocation({ platform: 'win32', resolveCommand: () => undefined }),
    /resolve devcontainer\.cmd from PATH.*npm prefix/i,
  );
});
