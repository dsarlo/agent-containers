import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: repository,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
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
