import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDevcontainerInvocation } from '../src/devcontainer.js';

const publicShim = '"%~dp0%\\node.exe" "%~dp0%\\node_modules\\@devcontainers\\cli\\devcontainer.js" %*';
const physicalWindowsFiles = {
  realpath: (path: string) => path,
  lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
};

test('Dev Containers invocation is direct argv on non-Windows platforms', () => {
  assert.deepEqual(resolveDevcontainerInvocation({ platform: 'linux' }), { command: 'devcontainer', prefixArgs: [] });
});

test('Windows runs the public Dev Containers JavaScript entry point through Node without cmd.exe', () => {
  const paths: string[][] = [];
  const invocation = resolveDevcontainerInvocation({
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    resolveCommand: () => 'C:\\Users\\agent\\AppData\\Roaming\\npm\\devcontainer.cmd',
    isRegularFile: () => true,
    ...physicalWindowsFiles,
    readCommandShim: () => publicShim,
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
    isRegularFile: () => true,
    ...physicalWindowsFiles,
    readCommandShim: () => publicShim,
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

test('Windows selects the first regular public Dev Containers shim in PATH order', () => {
  const invocation = resolveDevcontainerInvocation({
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    environment: { Path: 'C:\\first;D:\\second' },
    isRegularFile: (path) => path === 'C:\\first\\devcontainer.cmd' || path === 'D:\\second\\devcontainer.cmd',
    ...physicalWindowsFiles,
    readCommandShim: () => publicShim,
    resolveModule(_specifier, paths) {
      assert.deepEqual(paths, ['C:\\first\\node_modules']);
      return 'C:\\first\\node_modules\\@devcontainers\\cli\\devcontainer.js';
    },
  });

  assert.deepEqual(invocation, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    prefixArgs: ['C:\\first\\node_modules\\@devcontainers\\cli\\devcontainer.js'],
  });
});

test('Windows rejects a PATH devcontainer.cmd that is not a regular command shim', () => {
  assert.throws(
    () => resolveDevcontainerInvocation({
      platform: 'win32',
      resolveCommand: () => 'C:\\npm\\devcontainer.cmd',
      isRegularFile: () => false,
    }),
    /regular command shim/i,
  );
});

test('Windows rejects a regular PATH devcontainer.cmd that does not reference the public CLI package', () => {
  assert.throws(
    () => resolveDevcontainerInvocation({
      platform: 'win32',
      resolveCommand: () => 'C:\\npm\\devcontainer.cmd',
      isRegularFile: () => true,
      ...physicalWindowsFiles,
      readCommandShim: () => '"%~dp0%\\node.exe" "%~dp0%\\node_modules\\not-devcontainers\\cli.js" %*',
    }),
    /does not reference.*@devcontainers\\cli\\devcontainer\.js/i,
  );
});

test('Windows rejects a public CLI entry resolved outside the selected shim npm prefix', () => {
  assert.throws(
    () => resolveDevcontainerInvocation({
      platform: 'win32',
      resolveCommand: () => 'C:\\npm\\devcontainer.cmd',
      isRegularFile: () => true,
      ...physicalWindowsFiles,
      readCommandShim: () => publicShim,
      resolveModule: () => 'D:\\other\\node_modules\\@devcontainers\\cli\\devcontainer.js',
    }),
    /selected command shim.*npm prefix/i,
  );
});

test('Windows rejects a directory at a resolved command or public entry path', () => {
  assert.throws(
    () => resolveDevcontainerInvocation({
      platform: 'win32',
      resolveCommand: () => 'C:\\npm\\devcontainer.cmd',
      isRegularFile: () => true,
      readCommandShim: () => publicShim,
      resolveModule: () => 'C:\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js',
      realpath: (path) => path,
      lstat: () => ({ isFile: () => false, isSymbolicLink: () => false }),
    }),
    /physically resolve.*regular file/i,
  );
});

test('Windows rejects a linked public CLI entry whose physical target escapes the selected npm prefix', () => {
  assert.throws(
    () => resolveDevcontainerInvocation({
      platform: 'win32',
      resolveCommand: () => 'C:\\npm\\devcontainer.cmd',
      isRegularFile: () => true,
      readCommandShim: () => publicShim,
      resolveModule: () => 'C:\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js',
      realpath: (path) => path === 'C:\\npm' ? 'C:\\npm' : 'D:\\outside\\devcontainer.js',
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }),
    }),
    /physically contained.*npm prefix/i,
  );
});

test('Windows refuses lifecycle dispatch when no authoritative Dev Containers command resolver is available', () => {
  assert.throws(
    () => resolveDevcontainerInvocation({ platform: 'win32', resolveCommand: () => undefined }),
    /resolve devcontainer\.cmd from PATH.*npm prefix/i,
  );
});
