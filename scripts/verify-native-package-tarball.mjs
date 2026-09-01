import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const expectedDirectories = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];
const [tarball] = process.argv.slice(2);
assert.ok(tarball, 'usage: node scripts/verify-native-package-tarball.mjs <package.tgz>');

const execFile = promisify(execFileCallback);
const { stdout } = await execFile('tar', ['-tzf', tarball], { encoding: 'utf8' });
const entries = stdout.split('\n').filter(Boolean);
for (const directory of expectedDirectories) {
  const binary = new RegExp(`(^|/)prebuilds/${directory}/.+\\.node$`);
  assert.ok(entries.some((entry) => binary.test(entry)), `package tarball must contain a native binary for prebuilds/${directory}`);
}

process.stdout.write(`Verified packaged native prebuild matrix: ${expectedDirectories.join(', ')}.\n`);
