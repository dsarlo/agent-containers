import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = resolve(repository, 'scripts/verify-native-packaging-contract.mjs');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-containers-native-packaging-contract-'));

const requiredPackage = {
  files: ['dist/src', 'prebuilds'],
  scripts: {
    'native:verify-prebuilds': 'node scripts/verify-native-prebuilds.mjs',
    prepack: 'npm run build && npm run native:verify-prebuilds',
  },
};

const sourceBuildSteps = `
    steps:
      - run: npm run test:native
      - run: npm run native:prebuild
      - uses: actions/upload-artifact@v4
        with:
          name: native-prebuild-${'${{ matrix.artifact }}'}
          path: prebuilds`;
function assemblySteps(downloadPath) {
  return `
    needs: native-durability
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: native-prebuild-*
          path: ${downloadPath}
          merge-multiple: true
      - run: npm run native:verify-prebuilds
      - run: mkdir .pack && npm pack --pack-destination .pack
      - run: node scripts/verify-native-package-tarball.mjs .pack/*.tgz
      - uses: actions/upload-artifact@v4
        with:
          name: native-package`;
}
const packageSmokeSteps = `
    needs: assemble-native-package
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: native-package
          path: .pack
      - run: npm install --prefix .packed-native .pack/*.tgz
      - run: node scripts/test-native.mjs
        env:
          PACKED_NATIVE_PACKAGE_DIR: .packed-native/node_modules/@dsarlo/agent-containers
          EXPECTED_NATIVE_PUBLICATION_MODE: ${'${{ matrix.publication_mode }}'}`;

function workflowFor(entries, assemblyDownloadPath = '.') {
  const matrixEntries = entries.map((entry) => `        - runner: ${entry.runner}\n          artifact: ${entry.artifact}\n          publication_mode: ${entry.publicationMode}`).join('\n');
  return `name: CI
jobs:
  native-durability:
    runs-on: ${'${{ matrix.runner }}'}
    strategy:
      matrix:
        include:
${matrixEntries}
${sourceBuildSteps}
  assemble-native-package:
${assemblySteps(assemblyDownloadPath)}
  native-package-smoke:
    runs-on: ${'${{ matrix.runner }}'}
    strategy:
      matrix:
        include:
${matrixEntries}
${packageSmokeSteps}
`;
}

const x64Only = [
  { runner: 'ubuntu-latest', artifact: 'linux-x64', publicationMode: 'strict' },
  { runner: 'macos-15-intel', artifact: 'darwin-x64', publicationMode: 'strict' },
  { runner: 'windows-latest', artifact: 'win32-x64', publicationMode: 'recoverable' },
];
const allSupportedArchitectures = [
  ...x64Only,
  { runner: 'ubuntu-24.04-arm', artifact: 'linux-arm64', publicationMode: 'strict' },
  { runner: 'macos-14', artifact: 'darwin-arm64', publicationMode: 'strict' },
  { runner: 'windows-11-arm', artifact: 'win32-arm64', publicationMode: 'recoverable' },
];

async function writeFixture(workflow) {
  const workflowDirectory = join(fixtureRoot, '.github', 'workflows');
  await mkdir(workflowDirectory, { recursive: true });
  await writeFile(join(fixtureRoot, 'package.json'), `${JSON.stringify(requiredPackage, null, 2)}\n`, 'utf8');
  await writeFile(join(workflowDirectory, 'ci.yml'), workflow, 'utf8');
}

function verifyFixture() {
  try {
    execFileSync(process.execPath, [verifier], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, NATIVE_PACKAGING_CONTRACT_ROOT: fixtureRoot },
      stdio: 'pipe',
    });
    return { status: 0, output: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

try {
  await writeFixture(workflowFor(x64Only));
  const x64OnlyResult = verifyFixture();
  assert.notEqual(
    x64OnlyResult.status,
    0,
    'the static packaging contract must reject an x64-only native matrix that omits Linux, macOS, and Windows arm64 prebuilds',
  );

  await writeFixture(workflowFor(allSupportedArchitectures, 'prebuilds'));
  const nestedPrebuildsResult = verifyFixture();
  assert.notEqual(
    nestedPrebuildsResult.status,
    0,
    'the static packaging contract must reject downloading artifacts at prebuilds when each artifact already contains prebuilds/<tuple>/*.node',
  );

  await writeFixture(workflowFor(allSupportedArchitectures));
  const allArchitecturesResult = verifyFixture();
  assert.equal(
    allArchitecturesResult.status,
    0,
    `the static packaging contract must accept all six tested native prebuild tuples:\n${allArchitecturesResult.output}`,
  );

  process.stdout.write('Native packaging contract policy regression passed.\n');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
