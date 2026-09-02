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

const packageArchiveDirectory = 'native-package';
const packageArchiveGlob = `${packageArchiveDirectory}/*.tgz`;
const packageInstallArchiveGlob = `./${packageArchiveGlob}`;

function assertUnconditional(target, description) {
  assert.equal(Object.hasOwn(target, 'if'), false, `${description} must not define if`);
  assert.equal(Object.hasOwn(target, 'continue-on-error'), false, `${description} must not define continue-on-error`);
}

function jobDefinition(jobName) {
  const job = workflowDefinition.jobs?.[jobName];
  assert.ok(job, `workflow must define the ${jobName} job`);
  return job;
}

function assertExactNeeds(jobName, dependency) {
  assert.equal(
    jobDefinition(jobName).needs,
    dependency,
    `${jobName} must depend on exactly ${dependency}`,
  );
}

function runStep(jobName, command, description, isRelevantRun = (run) => run === command) {
  const job = jobDefinition(jobName);
  const relevantSteps = (job.steps ?? []).filter(({ run }) => typeof run === 'string' && isRelevantRun(run));
  assert.equal(relevantSteps.length, 1, `${description}; ${jobName} must not contain duplicate or alternative relevant commands`);
  assert.equal(relevantSteps[0].run, command, description);
  return relevantSteps[0];
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

const pinnedActions = Object.freeze({
  'actions/checkout': { version: 'v5', sha: 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09' },
  'actions/setup-node': { version: 'v5', sha: 'a0853c24544627f65ddf259abe73b1d18a591444' },
  'actions/download-artifact': { version: 'v5', sha: '634f93cb2916e3fdff6788551b99b062d0335ce0' },
  'actions/upload-artifact': { version: 'v5', sha: '330a01c490aca151604b8cf639adc76d48f6c5d4' },
});

function actionRef(action) {
  const pin = pinnedActions[action];
  assert.ok(pin, `workflow must not use an unrecognized ${action} action`);
  return `${action}@${pin.sha}`;
}

function assertPinnedActions() {
  const parsedUseSteps = [];
  for (const job of Object.values(workflowDefinition.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.uses === 'string') {
        parsedUseSteps.push(step.uses);
      }
    }
  }

  const rawUseLines = workflow
    .split('\n')
    .map((line, index, lines) => ({ line, precedingLine: lines[index - 1], index }))
    .filter(({ line }) => /^([ \t]*)-\s+uses:\s*.+$/.test(line));
  assert.equal(rawUseLines.length, parsedUseSteps.length, 'every parsed uses step must have one raw source line for adjacent-comment validation');

  const actionUseSteps = parsedUseSteps
    .map((uses, index) => ({ uses, rawSource: rawUseLines[index] }))
    .filter(({ uses }) => uses.startsWith('actions/'));
  assert.ok(actionUseSteps.length > 0, 'workflow must use pinned actions/* actions');

  for (const { uses, rawSource } of actionUseSteps) {
    const [action] = uses.split('@', 1);
    const pin = pinnedActions[action];
    assert.ok(pin, `workflow must not use an unrecognized ${action} action`);
    assert.equal(uses, actionRef(action), `${action} must be pinned to the reviewed ${pin.version} full commit SHA`);
    assert.match(
      rawSource.precedingLine,
      new RegExp(`^${rawSource.line.match(/^([ \t]*)/)[1]}# ${action} ${pin.version}$`),
      `${action} must have an adjacent human-readable ${pin.version} comment`,
    );
  }
}

function artifactStep(jobName, action) {
  const job = workflowDefinition.jobs?.[jobName];
  assert.ok(job, `workflow must define the ${jobName} job`);
  const actionSteps = (job.steps ?? []).filter(({ uses }) => typeof uses === 'string' && uses.startsWith(`${action}@`));
  assert.equal(actionSteps.length, 1, `${jobName} must use ${action} exactly once without decoy action steps`);
  assert.equal(actionSteps[0].uses, actionRef(action), `${jobName} must use the reviewed immutable ${action} commit SHA`);
  return actionSteps[0];
}

function assertLiveDevcontainerContract() {
  const job = jobDefinition('live-devcontainer');
  assertUnconditional(job, 'live-devcontainer');
  assert.equal(job['runs-on'], 'ubuntu-latest', 'live-devcontainer must run on Ubuntu');

  const checkout = artifactStep('live-devcontainer', 'actions/checkout');
  const setupNode = artifactStep('live-devcontainer', 'actions/setup-node');
  const npmCi = runStep('live-devcontainer', 'npm ci', 'live-devcontainer must install locked dependencies with npm ci');
  const nativeBuild = runStep('live-devcontainer', 'npm run build:native', 'live-devcontainer must source-build the native addon after npm ci');
  const installDevContainersCli = runStep('live-devcontainer', 'npm install --global @devcontainers/cli@0.89.0', 'live-devcontainer must install the exact reviewed Dev Containers CLI globally');

  const prerequisiteSteps = (job.steps ?? []).filter(({ run }) => (
    typeof run === 'string'
    && /\bdocker\s+version\b/.test(run)
    && /\bdevcontainer\s+--version\b/.test(run)
    && /\bgit\s+worktree\s+add\b/.test(run)
    && /\brelative-paths\b/.test(run)
  ));
  assert.equal(prerequisiteSteps.length, 1, 'live-devcontainer must have exactly one Docker, Dev Containers, and relative-worktree prerequisite step');
  const liveIntegration = runStep('live-devcontainer', 'AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION=1 npm run test:integration', 'live-devcontainer must run the required live integration suite');
  const nativeBuildIndex = job.steps.indexOf(nativeBuild);
  assert.ok(nativeBuildIndex > job.steps.indexOf(npmCi), 'live-devcontainer must build the native addon after npm ci');
  assert.ok(nativeBuildIndex < job.steps.indexOf(installDevContainersCli), 'live-devcontainer must build the native addon before installing the Dev Containers CLI');
  assert.ok(nativeBuildIndex < job.steps.indexOf(prerequisiteSteps[0]), 'live-devcontainer must build the native addon before Docker and linked-worktree prerequisites');
  assert.ok(nativeBuildIndex < job.steps.indexOf(liveIntegration), 'live-devcontainer must build the native addon before the live integration suite');
  for (const [step, description] of [
    [checkout, 'live-devcontainer checkout step'],
    [setupNode, 'live-devcontainer setup-node step'],
    [npmCi, 'live-devcontainer npm ci step'],
    [nativeBuild, 'live-devcontainer native addon build step'],
    [installDevContainersCli, 'live-devcontainer Dev Containers CLI install step'],
    [prerequisiteSteps[0], 'live-devcontainer prerequisite step'],
    [liveIntegration, 'live-devcontainer live integration step'],
  ]) {
    assertUnconditional(step, description);
  }
}

function isDisabledIncludeHiddenFilesInput(inputs) {
  if (!Object.hasOwn(inputs ?? {}, 'include-hidden-files')) {
    return true;
  }
  const value = inputs['include-hidden-files'];
  return value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false');
}

assertPinnedActions();

assert.ok(packageJson.files.includes('prebuilds'), 'published files must include bundled native prebuilds');
assert.ok(packageJson.scripts['native:verify-prebuilds'], 'package must verify all bundled prebuilds before packing');
assert.match(packageJson.scripts.prepack, /native:verify-prebuilds/, 'prepack must fail closed when the cross-platform prebuild matrix is incomplete');
assert.doesNotMatch(packageJson.scripts.prepack, /native:prebuild/, 'prepack must not create a publisher-host-only native prebuild');
for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
  assert.equal(packageJson.scripts[lifecycle], undefined, `ordinary npm installs must not run ${lifecycle}`);
}

assertUnconditional(jobDefinition('native-durability'), 'native-durability');
assertAllNativeBuilds('native-durability');
const nativeTestStep = runStep('native-durability', 'npm run test:native', 'each native platform must source-build and smoke-test the addon', (run) => /\bnpm run test:native\b/.test(run));
assertUnconditional(nativeTestStep, 'native-durability npm run test:native step');
const nativePrebuildStep = runStep('native-durability', 'npm run native:prebuild', 'each native platform must produce its own prebuild', (run) => /\bnpm run native:prebuild\b/.test(run));
assertUnconditional(nativePrebuildStep, 'native-durability npm run native:prebuild step');
const nativePrebuildUpload = artifactStep('native-durability', 'actions/upload-artifact');
assertUnconditional(nativePrebuildUpload, 'native-durability prebuild upload step');
assert.equal(nativePrebuildUpload.with?.name, 'native-prebuild-${{ matrix.artifact }}', 'each native build must upload a named prebuild artifact');
assert.equal(nativePrebuildUpload.with?.path, 'prebuilds', 'each native prebuild artifact must preserve prebuilds/<tuple>/*.node as its archive root');

const nativePackageAssembly = jobDefinition('assemble-native-package');
assertUnconditional(nativePackageAssembly, 'assemble-native-package');
assertExactNeeds('assemble-native-package', 'native-durability');
const nativePrebuildDownload = artifactStep('assemble-native-package', 'actions/download-artifact');
assertUnconditional(nativePrebuildDownload, 'assemble-native-package prebuild download step');
assert.equal(nativePrebuildDownload.with?.pattern, 'native-prebuild-*', 'package assembly must download every native prebuild artifact');
assert.equal(nativePrebuildDownload.with?.path, '.', 'package assembly must download artifacts at its workspace root so their prebuilds/<tuple>/*.node archive roots are not nested');
assert.equal(nativePrebuildDownload.with?.['merge-multiple'], true, 'package assembly must merge native prebuild artifacts into one matrix');
const nativePrebuildVerification = runStep('assemble-native-package', 'npm run native:verify-prebuilds', 'package assembly must reject incomplete native prebuild matrices', (run) => /\bnpm run native:verify-prebuilds\b/.test(run));
const nativePackageCreation = runStep('assemble-native-package', `mkdir ${packageArchiveDirectory} && npm pack --pack-destination ${packageArchiveDirectory}`, 'package assembly must create the distributable tarball in a non-hidden directory', (run) => /\bnpm pack\b/.test(run));
const nativePackageVerification = runStep('assemble-native-package', `node scripts/verify-native-package-tarball.mjs ${packageArchiveGlob}`, 'package assembly must verify every required prebuild was actually packaged in the archive it uploads', (run) => /\bnode scripts\/verify-native-package-tarball\.mjs\b/.test(run));
const nativePackageUpload = artifactStep('assemble-native-package', 'actions/upload-artifact');
for (const [step, description] of [
  [nativePrebuildVerification, 'assemble-native-package native prebuild verification step'],
  [nativePackageCreation, 'assemble-native-package package creation step'],
  [nativePackageVerification, 'assemble-native-package tarball verification step'],
  [nativePackageUpload, 'assemble-native-package package upload step'],
]) {
  assertUnconditional(step, description);
}
assert.equal(nativePackageUpload.with?.name, 'native-package', 'package assembly must upload the final tarball artifact');
assert.equal(nativePackageUpload.with?.path, packageArchiveGlob, 'package assembly must upload the exact non-hidden tarball it assembled');
assert.equal(nativePackageUpload.with?.['if-no-files-found'], 'error', 'package assembly must fail if the final tarball artifact is missing');
assert.ok(isDisabledIncludeHiddenFilesInput(nativePackageUpload.with), 'package assembly must leave include-hidden-files absent, boolean false, or a literal false string');

const nativePackageSmoke = jobDefinition('native-package-smoke');
assertUnconditional(nativePackageSmoke, 'native-package-smoke');
assertAllNativeBuilds('native-package-smoke');
assertExactNeeds('native-package-smoke', 'assemble-native-package');
const nativePackageDownload = artifactStep('native-package-smoke', 'actions/download-artifact');
assertUnconditional(nativePackageDownload, 'native-package-smoke package download step');
assert.equal(nativePackageDownload.with?.name, 'native-package', 'package smoke tests must download the assembled tarball artifact');
assert.equal(nativePackageDownload.with?.path, packageArchiveDirectory, 'package smoke tests must restore the assembled tarball to its non-hidden archive directory');
const nativePackageInstall = runStep('native-package-smoke', `mkdir .packed-native && npm install --prefix .packed-native ${packageInstallArchiveGlob}`, 'package smoke tests must install the exact assembled tarball with an unambiguous filesystem path and without lifecycle downloads', (run) => /\bnpm install\b/.test(run));
const nativePackageSmokeExecution = runStep('native-package-smoke', 'node scripts/test-native.mjs', 'package smoke tests must execute the installed production package smoke command', (run) => /\bnode scripts\/test-native\.mjs\b/.test(run));
assertUnconditional(nativePackageInstall, 'native-package-smoke package installation step');
assertUnconditional(nativePackageSmokeExecution, 'native-package-smoke production package smoke step');
assert.equal(
  nativePackageSmokeExecution.env?.PACKED_NATIVE_PACKAGE_DIR,
  '${{ github.workspace }}/.packed-native/node_modules/@dsarlo/agent-containers',
  'the production package smoke command must load the installed package from its workspace path',
);
assert.equal(
  nativePackageSmokeExecution.env?.EXPECTED_NATIVE_PUBLICATION_MODE,
  '${{ matrix.publication_mode }}',
  'the production package smoke command must assert the matrix publication mode on the same step',
);

assertLiveDevcontainerContract();

process.stdout.write('Native packaging workflow contract passed.\n');
