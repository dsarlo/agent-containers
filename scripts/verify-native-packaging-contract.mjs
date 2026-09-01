import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const defaultRepository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(process.env.NATIVE_PACKAGING_CONTRACT_ROOT ?? defaultRepository);
const packageJson = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
const workflowPath = resolve(repository, '.github/workflows/ci.yml');
const workflow = await readFile(workflowPath, 'utf8');
const workflowDefinition = parse(workflow);
const requiredNativeBuilds = [
  { runner: 'ubuntu-latest', artifact: 'linux-x64', publicationMode: 'strict' },
  { runner: 'ubuntu-24.04-arm', artifact: 'linux-arm64', publicationMode: 'strict' },
  { runner: 'macos-15-intel', artifact: 'darwin-x64', publicationMode: 'strict' },
  { runner: 'macos-14', artifact: 'darwin-arm64', publicationMode: 'strict' },
  { runner: 'windows-latest', artifact: 'win32-x64', publicationMode: 'recoverable' },
  { runner: 'windows-11-arm', artifact: 'win32-arm64', publicationMode: 'recoverable' },
];

function requireMatch(pattern, description) {
  assert.match(workflow, pattern, description);
}

function compareNativeBuilds(left, right) {
  return left.artifact.localeCompare(right.artifact);
}

function normalizeNativeMatrix(jobName) {
  const job = workflowDefinition.jobs?.[jobName];
  assert.ok(job, `workflow must define the ${jobName} job`);
  assert.equal(job['runs-on'], '${{ matrix.runner }}', `${jobName} must select the documented runner from its native matrix`);
  const include = job.strategy?.matrix?.include;
  assert.ok(Array.isArray(include), `${jobName} must define an explicit native runner matrix`);
  return include
    .map(({ runner, artifact, publication_mode: publicationMode }) => ({ runner, artifact, publicationMode }))
    .sort(compareNativeBuilds);
}

function assertAllNativeBuilds(jobName) {
  assert.deepEqual(
    normalizeNativeMatrix(jobName),
    [...requiredNativeBuilds].sort(compareNativeBuilds),
    `${jobName} must cover exactly the six tested native Node-API tuples on documented hosted runners`,
  );
}

assert.ok(packageJson.files.includes('prebuilds'), 'published files must include bundled native prebuilds');
assert.ok(packageJson.scripts['native:verify-prebuilds'], 'package must verify all bundled prebuilds before packing');
assert.match(packageJson.scripts.prepack, /native:verify-prebuilds/, 'prepack must fail closed when the cross-platform prebuild matrix is incomplete');
assert.doesNotMatch(packageJson.scripts.prepack, /native:prebuild/, 'prepack must not create a publisher-host-only native prebuild');
for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
  assert.equal(packageJson.scripts[lifecycle], undefined, `ordinary npm installs must not run ${lifecycle}`);
}

assertAllNativeBuilds('native-durability');
requireMatch(/npm run test:native/, 'each native platform must source-build and smoke-test the addon');
requireMatch(/npm run native:prebuild/, 'each native platform must produce its own prebuild');
requireMatch(/name:\s*native-prebuild-\$\{\{ matrix\.artifact \}\}/, 'each native build must upload a named prebuild artifact');
requireMatch(/path:\s*prebuilds/, 'native build artifacts must contain the prebuilds directory');

assert.ok(workflowDefinition.jobs?.['assemble-native-package'], 'workflow must assemble one cross-platform package after native builds');
requireMatch(/needs:\s*native-durability/, 'package assembly must wait for every native build');
requireMatch(/pattern:\s*native-prebuild-\*/, 'package assembly must download every native prebuild artifact');
requireMatch(/merge-multiple:\s*true/, 'package assembly must merge native prebuild artifacts into one matrix');
requireMatch(/npm run native:verify-prebuilds/, 'package assembly must reject incomplete native prebuild matrices');
requireMatch(/npm pack --pack-destination \.pack/, 'package assembly must create the distributable tarball');
requireMatch(/node scripts\/verify-native-package-tarball\.mjs \.pack\/\*\.tgz/, 'package assembly must verify every required prebuild was actually packaged');
requireMatch(/name:\s*native-package/, 'package assembly must upload the final tarball');

assertAllNativeBuilds('native-package-smoke');
requireMatch(/needs:\s*assemble-native-package/, 'package smoke tests must wait for the assembled tarball');
requireMatch(/npm install --prefix \.packed-native \.pack\/\*\.tgz/, 'package smoke tests must install the assembled tarball');
requireMatch(/PACKED_NATIVE_PACKAGE_DIR/, 'package smoke tests must load the installed production adapter');
requireMatch(/EXPECTED_NATIVE_PUBLICATION_MODE/, 'package smoke tests must assert the platform-specific publication mode');

process.stdout.write('Native packaging workflow contract passed.\n');
