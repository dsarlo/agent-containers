import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));

assert.doesNotMatch(
  packageJson.scripts.test,
  /[*?[\]{}]/,
  'test must not rely on a shell-expanded file glob',
);
assert.match(
  packageJson.scripts.test,
  /^npm run build && node scripts\/run-tests\.mjs$/,
  'test must build then invoke the cross-platform test runner',
);

const runner = await readFile(resolve(repository, 'scripts/run-tests.mjs'), 'utf8');
assert.match(runner, /readdir\(/, 'test runner must discover compiled tests through Node fs APIs');
assert.match(runner, /\.sort\(\)/, 'test runner must select compiled tests in deterministic order');
assert.match(runner, /shell:\s*false/, 'test runner must not invoke a shell');
assert.match(runner, /--import/, 'test runner must import the compiled test setup module');
assert.match(runner, /--test/, 'test runner must invoke the Node test runner');
assert.match(runner, /No compiled test files found/, 'test runner must fail explicitly when no compiled tests exist');

process.stdout.write('Cross-platform test runner contract passed.\n');
