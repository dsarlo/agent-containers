import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = join(root, 'scripts', 'verify-lockfile-policy.mjs');
const source = await readFile(join(root, 'package-lock.json'), 'utf8');
const fixture = await mkdtemp(join(tmpdir(), 'agent-containers-lock-policy-'));
try {
  await writeFile(join(fixture, 'package-lock.json'), source);
  let result = spawnSync(process.execPath, [verifier], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lock = JSON.parse(source);
  const entry = Object.values(lock.packages).find((value) => value && typeof value === 'object' && 'resolved' in value && 'integrity' in value);
  entry.resolved = 'https://evil.example.invalid/pkg.tgz';
  await writeFile(join(fixture, 'package-lock.json'), JSON.stringify(lock));
  result = spawnSync(process.execPath, [verifier], { cwd: fixture, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /registry\.npmjs\.org/);
} finally { await rm(fixture, { recursive: true, force: true }); }
