import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const packageRoot = process.env.PACKED_NATIVE_PACKAGE_DIR ?? process.cwd();
const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-smoke-'));
const installRoot = process.env.PACKED_NATIVE_PACKAGE_DIR ? join(packageRoot, '..', '..') : join(root, 'installed');
if (!process.env.PACKED_NATIVE_PACKAGE_DIR) {
  const installed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-package-lock', '--prefix', installRoot, packageRoot], { encoding: 'utf8' });
  assert.equal(installed.status, 0, `source smoke must install the package before invoking its bin: ${installed.stderr}`);
}
const binRoot = join(installRoot, 'node_modules', '.bin');
const extension = process.platform === 'win32' ? '.cmd' : '';
const cli = (name) => join(binRoot, `${name}${extension}`);
const run = (name, args) => spawnSync(cli(name), args, { cwd: root, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(root, 'state') } });
for (const name of ['ac', 'agent-containers']) {
  assert.ok((await lstat(cli(name))).isFile() || (await lstat(cli(name))).isSymbolicLink(), `smoke must invoke the installed ${name} executable`);
  assert.equal(run(name, ['--help']).status, 0, `installed ${name} executable must run`);
}
assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
// The source-install smoke intentionally has no native addon. --force follows
// the documented safe replacement path without claiming lifecycle durability.
const init = run('ac', ['init', '--force']);
assert.equal(init.status, 0, `installed CLI init must succeed: ${init.stderr}`);
assert.match(await readFile(join(root, '.agent-containers.yml'), 'utf8'), /"version": 2/);
const status = run('ac', ['status']);
assert.equal(status.status, 0, `installed CLI status must succeed: ${status.stderr}`);
const doctor = run('agent-containers', ['doctor', '--json']);
assert.match(doctor.stdout, /"schemaVersion": 1/, 'installed CLI doctor must emit stable JSON');
assert.match(doctor.stdout, /"local\.state\.durability"/, 'installed CLI doctor must emit its complete stable local inventory');
