import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const cli = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-containers.cmd' : 'agent-containers');
const run = (args) => spawnSync(cli, args, { cwd: root, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(root, 'state') } });
assert.ok((await lstat(cli)).isFile() || (await lstat(cli)).isSymbolicLink(), 'smoke must invoke the package-installed executable link');
assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
const init = run(['init']);
assert.equal(init.status, 0, `installed CLI init must succeed: ${init.stderr}`);
assert.match(await readFile(join(root, '.agent-containers.yml'), 'utf8'), /"version": 2/);
const candidate = JSON.parse(await readFile(join(root, '.agent-containers.yml'), 'utf8'));
candidate.workspace.worktreeRoot = 'portable-worktrees';
const input = join(root, 'candidate.json');
await writeFile(input, JSON.stringify(candidate));
const configure = run(['configure', '--non-interactive', '--from', input, '--yes']);
assert.equal(configure.status, 0, `installed CLI configure must succeed: ${configure.stderr}`);
assert.match(await readFile(join(root, '.agent-containers.yml'), 'utf8'), /portable-worktrees/);
const status = run(['status']);
assert.equal(status.status, 0, `installed CLI status must succeed: ${status.stderr}`);
const doctor = run(['doctor', '--json']);
assert.match(doctor.stdout, /"schemaVersion": 1/, 'installed CLI doctor must emit stable JSON');
assert.match(doctor.stdout, /"local\.state\.durability"/, 'installed CLI doctor must emit its complete stable local inventory');
