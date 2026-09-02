import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeSmoke = await readFile(resolve(repository, 'scripts/test-native.mjs'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
const workflow = await readFile(resolve(repository, '.github/workflows/ci.yml'), 'utf8');

assert.match(
  nativeSmoke,
  /await import\(pathToFileURL\(join\(packageRoot, 'dist\/src\/state\.js'\)\)\.href\)/,
  'native smoke must load the compiled production state module from the package under test',
);
assert.doesNotMatch(
  nativeSmoke,
  /setStateDurabilityAdapterForTesting/,
  'native smoke must not replace the production durability adapter with a test fake',
);
for (const operation of ['saveMetadata', 'withWorkspaceLock', 'recordManualRecovery', 'clearManualRecovery', 'loadManualRecovery']) {
  assert.match(nativeSmoke, new RegExp(`\\b${operation}\\b`), `native smoke must exercise production ${operation}`);
}
assert.match(nativeSmoke, /appendFile\(/, 'native smoke must append a truncated journal tail after a production recovery record');
assert.match(nativeSmoke, /truncated journal tail/i, 'native smoke must prove that production reads preserve the earlier recovery record after a truncated tail');
assert.match(nativeSmoke, /containerIds: \['a'\.repeat\(64\)\]/, 'native smoke must persist and reload a canonical Docker container ID rather than a filtered hint');

assert.match(packageJson.scripts['test:native'], /node scripts\/test-native\.mjs/, 'source-native CI must execute the lifecycle smoke script');
assert.match(workflow, /- run: npm run test:native/, 'each native build matrix runner must execute the lifecycle smoke script');
assert.match(workflow, /run: node scripts\/test-native\.mjs/, 'each packaged-native matrix runner must execute the lifecycle smoke script');

process.stdout.write('Native production state lifecycle smoke contract passed.\n');
