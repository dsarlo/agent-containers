import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];
const npmCli = process.env.npm_execpath;
const output = npmCli
  ? execFileSync(process.execPath, [npmCli, ...packArgs], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  : process.platform === 'win32'
    ? (() => { throw new Error('npm_execpath is required to run the npm pack contract on Windows without a shell.'); })()
    : execFileSync('npm', packArgs, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const parsed = JSON.parse(output);
const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
assert.ok(packed && Array.isArray(packed.files), 'npm pack dry-run must report one package file list');
const paths = new Set(packed.files.map((entry) => entry.path));
for (const required of [
  'native/helper/manifest.json',
  'native/helper/bin/agent-containers-helper-linux-x64',
  'native/helper/bin/agent-containers-helper-linux-arm64',
]) {
  assert.ok(paths.has(required), `published package must include required package-owned helper payload: ${required}`);
}
process.stdout.write('Native helper npm-pack contents contract passed.\n');
