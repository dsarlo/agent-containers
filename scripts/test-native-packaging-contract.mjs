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

const packageArchiveDirectory = 'native-package';
const packageInstallArchiveGlob = `./${packageArchiveDirectory}/*.tgz`;
const liveNativeBuildStep = '      - run: npm run build:native';
const actionRefs = Object.freeze({
  'actions/checkout': 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
  'actions/setup-node': 'a0853c24544627f65ddf259abe73b1d18a591444',
  'actions/download-artifact': '634f93cb2916e3fdff6788551b99b062d0335ce0',
  'actions/upload-artifact': '330a01c490aca151604b8cf639adc76d48f6c5d4',
});

const legacyV4ActionRefs = Object.freeze({
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/download-artifact': 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
});

function actionStep(action, ref = actionRefs[action]) {
  return `      # ${action} v5\n      - uses: ${action}@${ref}${action === 'actions/checkout' ? '\n        with:\n          persist-credentials: false' : ''}`;
}

function sourceBuildSteps(refs = actionRefs) {
  return `
    steps:
      - run: npm run test:native
      - run: npm run native:prebuild
${actionStep('actions/upload-artifact', refs['actions/upload-artifact'])}
        with:
          name: native-prebuild-${'${{ matrix.artifact }}'}
          path: prebuilds`;
}

function assemblySteps(downloadPath, archiveDirectory = packageArchiveDirectory, uploadArtifactOptions = '', refs = actionRefs) {
  return `
    needs: native-durability
    steps:
${actionStep('actions/download-artifact', refs['actions/download-artifact'])}
        with:
          pattern: native-prebuild-*
          path: ${downloadPath}
          merge-multiple: true
      - run: npm run native:verify-prebuilds
      - run: mkdir ${archiveDirectory} && npm pack --pack-destination ${archiveDirectory}
      - run: node scripts/verify-native-package-tarball.mjs ${archiveDirectory}/*.tgz
${actionStep('actions/upload-artifact', refs['actions/upload-artifact'])}
        with:
          name: native-package
          path: ${archiveDirectory}/*.tgz
          if-no-files-found: error${uploadArtifactOptions}`;
}
function packageSmokeSteps(archiveDirectory = packageArchiveDirectory, refs = actionRefs) {
  return `
    needs: assemble-native-package
    steps:
${actionStep('actions/download-artifact', refs['actions/download-artifact'])}
        with:
          name: native-package
          path: ${archiveDirectory}
      - run: mkdir .packed-native && npm install --ignore-scripts --prefix .packed-native ./${archiveDirectory}/*.tgz
      - run: node scripts/test-native.mjs
        env:
          PACKED_NATIVE_PACKAGE_DIR: ${'${{ github.workspace }}'}/.packed-native/node_modules/@dsarlo/agent-containers
          EXPECTED_NATIVE_PUBLICATION_MODE: ${'${{ matrix.publication_mode }}'}`;
}

function liveDevcontainerSteps(refs = actionRefs, nativeBuildStep = liveNativeBuildStep) {
  return `
  live-devcontainer:
    runs-on: ubuntu-latest
    steps:
${actionStep('actions/checkout', refs['actions/checkout'])}
${actionStep('actions/setup-node', refs['actions/setup-node'])}
        with:
          node-version: 20.19.0
          cache: npm
      - run: npm ci --ignore-scripts
${nativeBuildStep}
      - run: npm install --global --ignore-scripts @devcontainers/cli@0.89.0
      - name: Require Docker, Dev Containers, and relative linked-worktree support
        run: |
          docker version
          devcontainer --version
          worktree_help="$(git worktree add -h 2>&1 || true)"
          grep -Eq -- '(^|[[:space:]])--(\\[no-\\])?relative-paths([[:space:]]|$)' <<<"\${worktree_help}"
      - run: AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION=1 npm run test:integration`;
}

function workflowFor(entries, assemblyDownloadPath = '.', archiveDirectory = packageArchiveDirectory, uploadArtifactOptions = '', refs = actionRefs, nativeBuildStep = liveNativeBuildStep) {
  const matrixEntries = entries.map((entry) => `        - runner: ${entry.runner}\n          artifact: ${entry.artifact}\n          publication_mode: ${entry.publicationMode}`).join('\n');
  return `name: CI
jobs:
  native-durability:
    runs-on: ${'${{ matrix.runner }}'}
    strategy:
      matrix:
        include:
${matrixEntries}
${sourceBuildSteps(refs)}
  assemble-native-package:
${assemblySteps(assemblyDownloadPath, archiveDirectory, uploadArtifactOptions, refs)}
  native-package-smoke:
    runs-on: ${'${{ matrix.runner }}'}
    strategy:
      matrix:
        include:
${matrixEntries}
${packageSmokeSteps(archiveDirectory, refs)}
${liveDevcontainerSteps(refs, nativeBuildStep)}
`;
}

function insertNativeDurabilityStep(workflow, step) {
  return workflow.replace('      - run: npm run test:native', `${step}\n      - run: npm run test:native`);
}

function appendAssemblyStep(workflow, step) {
  return workflow.replace('  native-package-smoke:', `${step}\n  native-package-smoke:`);
}

function relocateNativeDurabilityCommand(workflow, command) {
  return appendAssemblyStep(
    workflow.replace(`      - run: ${command}`, '      - run: npm run build'),
    `      - run: ${command}`,
  );
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
  await writeFixture(workflowFor(allSupportedArchitectures, '.', packageArchiveDirectory, '', actionRefs, ''));
  const missingLiveNativeBuildResult = verifyFixture();
  assert.notEqual(
    missingLiveNativeBuildResult.status,
    0,
    'the static packaging contract must reject live-devcontainer when npm ci is not followed by an npm run build:native step before Docker, prerequisites, and live integration',
  );

  await writeFixture(workflowFor(allSupportedArchitectures));
  const pinnedActionsResult = verifyFixture();
  assert.equal(
    pinnedActionsResult.status,
    0,
    `the static packaging contract must accept full immutable actions/* commit SHAs with adjacent action/version comments:\n${pinnedActionsResult.output}`,
  );

  await writeFixture(workflowFor(allSupportedArchitectures, '.', packageArchiveDirectory, '', legacyV4ActionRefs));
  const legacyV4ActionsResult = verifyFixture();
  assert.notEqual(
    legacyV4ActionsResult.status,
    0,
    'the static packaging contract must reject the reviewed legacy Node-20-runtime actions/* v4 commit pins',
  );

  const liveNativeBuildGuardFixtures = [
    {
      name: 'removed build:native step',
      workflow: (fixture) => fixture.replace(liveNativeBuildStep, '      - run: npm run build'),
    },
    {
      name: 'conditional build:native step',
      workflow: (fixture) => fixture.replace(liveNativeBuildStep, '      - if: always()\n        run: npm run build:native'),
    },
    {
      name: 'error-tolerant build:native step',
      workflow: (fixture) => fixture.replace(liveNativeBuildStep, '      - continue-on-error: true\n        run: npm run build:native'),
    },
    {
      name: 'duplicate build:native step',
      workflow: (fixture) => fixture.replace(liveNativeBuildStep, `${liveNativeBuildStep}\n${liveNativeBuildStep}`),
    },
    {
      name: 'build:native after prerequisites',
      workflow: (fixture) => fixture.replace(
        `${liveNativeBuildStep}\n      - run: npm install --global --ignore-scripts @devcontainers/cli@0.89.0`,
        '      - run: npm install --global --ignore-scripts @devcontainers/cli@0.89.0',
      ).replace(
        '      - run: AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION=1 npm run test:integration',
        `${liveNativeBuildStep}\n      - run: AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION=1 npm run test:integration`,
      ),
    },
  ];
  const liveNativeBuildGuardResults = [];
  for (const fixture of liveNativeBuildGuardFixtures) {
    await writeFixture(fixture.workflow(workflowFor(allSupportedArchitectures)));
    liveNativeBuildGuardResults.push({ ...fixture, result: verifyFixture() });
  }
  assert.ok(
    liveNativeBuildGuardResults.every(({ result }) => result.status !== 0),
    `the static packaging contract must reject every missing, conditional, error-tolerant, duplicate, or late live-devcontainer build:native step:\n${liveNativeBuildGuardResults.map(({ name, result }) => `${name}: ${result.output}`).join('\n')}`,
  );

  const inlineCommentedActionFixtures = [
    {
      name: 'mutable checkout tag',
      step: `      # actions/checkout v4\n      - uses: actions/checkout@v4 # mutable`,
    },
    {
      name: 'malformed checkout SHA',
      step: `      # actions/checkout v4\n      - uses: actions/checkout@not-a-full-immutable-sha # malformed`,
    },
    {
      name: 'unknown action',
      step: `      # actions/cache v4\n      - uses: actions/cache@0c45773b623bea8c8e75f6e2d0d9d44ebc6e46b1 # unknown`,
    },
  ];
  const inlineCommentedActionResults = [];
  for (const fixture of inlineCommentedActionFixtures) {
    await writeFixture(insertNativeDurabilityStep(workflowFor(allSupportedArchitectures), fixture.step));
    inlineCommentedActionResults.push({ ...fixture, result: verifyFixture() });
  }
  assert.ok(
    inlineCommentedActionResults.every(({ result }) => result.status !== 0),
    `the static packaging contract must reject every inline-commented mutable, malformed, or unknown actions/* reference:\n${inlineCommentedActionResults.map(({ name, result }) => `${name}: ${result.output}`).join('\n')}`,
  );

  await writeFixture(workflowFor(
    allSupportedArchitectures,
    '.',
    packageArchiveDirectory,
    '',
    { ...actionRefs, 'actions/upload-artifact': 'v4' },
  ));
  const mutableActionTagResult = verifyFixture();
  assert.notEqual(
    mutableActionTagResult.status,
    0,
    'the static packaging contract must reject mutable actions/*@vN tags',
  );

  const duplicateSafetyResults = [];
  await writeFixture(appendAssemblyStep(
    workflowFor(allSupportedArchitectures),
    `${actionStep('actions/upload-artifact')}
        with:
          name: native-package-decoy
          path: .pack/*.tgz
          include-hidden-files: true`,
  ));
  duplicateSafetyResults.push({ name: 'later unsafe upload-artifact step', result: verifyFixture() });

  await writeFixture(appendAssemblyStep(
    workflowFor(allSupportedArchitectures),
    '      - run: npm pack --pack-destination .pack',
  ));
  duplicateSafetyResults.push({ name: 'later unsafe npm pack command', result: verifyFixture() });
  assert.ok(
    duplicateSafetyResults.every(({ result }) => result.status !== 0),
    `the static packaging contract must reject every later unsafe duplicate/decoy step:\n${duplicateSafetyResults.map(({ name, result }) => `${name}: ${result.output}`).join('\n')}`,
  );

  const relocatedNativeDurabilityCommands = ['npm run test:native', 'npm run native:prebuild'].map((command) => ({
    command,
    result: null,
  }));
  for (const fixture of relocatedNativeDurabilityCommands) {
    await writeFixture(relocateNativeDurabilityCommand(workflowFor(allSupportedArchitectures), fixture.command));
    fixture.result = verifyFixture();
  }
  assert.ok(
    relocatedNativeDurabilityCommands.every(({ result }) => result.status !== 0),
    `the static packaging contract must reject test:native and native:prebuild when either is relocated outside native-durability:\n${relocatedNativeDurabilityCommands.map(({ command, result }) => `${command}: ${result.output}`).join('\n')}`,
  );

  const nativeDurabilityGuardFixtures = [
    {
      name: 'job if',
      workflow: (fixture) => fixture.replace('  native-durability:\n', '  native-durability:\n    if: always()\n'),
    },
    {
      name: 'job continue-on-error',
      workflow: (fixture) => fixture.replace('    runs-on: ${{ matrix.runner }}', '    continue-on-error: true\n    runs-on: ${{ matrix.runner }}'),
    },
    {
      name: 'test:native if',
      workflow: (fixture) => fixture.replace('      - run: npm run test:native', '      - if: always()\n        run: npm run test:native'),
    },
    {
      name: 'test:native continue-on-error',
      workflow: (fixture) => fixture.replace('      - run: npm run test:native', '      - continue-on-error: true\n        run: npm run test:native'),
    },
    {
      name: 'native:prebuild if',
      workflow: (fixture) => fixture.replace('      - run: npm run native:prebuild', '      - if: always()\n        run: npm run native:prebuild'),
    },
    {
      name: 'native:prebuild continue-on-error',
      workflow: (fixture) => fixture.replace('      - run: npm run native:prebuild', '      - continue-on-error: true\n        run: npm run native:prebuild'),
    },
    {
      name: 'prebuild-upload if',
      workflow: (fixture) => fixture.replace(actionStep('actions/upload-artifact'), `${actionStep('actions/upload-artifact')}\n        if: always()`),
    },
    {
      name: 'prebuild-upload continue-on-error',
      workflow: (fixture) => fixture.replace(actionStep('actions/upload-artifact'), `${actionStep('actions/upload-artifact')}\n        continue-on-error: true`),
    },
  ];
  const nativeDurabilityGuardResults = [];
  for (const fixture of nativeDurabilityGuardFixtures) {
    await writeFixture(fixture.workflow(workflowFor(allSupportedArchitectures)));
    nativeDurabilityGuardResults.push({ ...fixture, result: verifyFixture() });
  }
  assert.ok(
    nativeDurabilityGuardResults.every(({ result }) => result.status !== 0),
    `the static packaging contract must reject every conditional or error-tolerant native-durability gate:\n${nativeDurabilityGuardResults.map(({ name, result }) => `${name}: ${result.output}`).join('\n')}`,
  );

  await writeFixture(workflowFor(allSupportedArchitectures).replace(/\n {2}live-devcontainer:[\s\S]*$/, '\n'));
  const missingLiveDevcontainerResult = verifyFixture();
  assert.notEqual(
    missingLiveDevcontainerResult.status,
    0,
    'the static packaging contract must reject a workflow without the live-devcontainer job',
  );

  const liveDevcontainerGuardFixtures = [
    {
      name: 'job if',
      workflow: (fixture) => fixture.replace('  live-devcontainer:\n', '  live-devcontainer:\n    if: always()\n'),
    },
    {
      name: 'job continue-on-error',
      workflow: (fixture) => fixture.replace('  live-devcontainer:\n    runs-on:', '  live-devcontainer:\n    continue-on-error: true\n    runs-on:'),
    },
    {
      name: 'checkout if',
      workflow: (fixture) => fixture.replace(actionStep('actions/checkout'), `${actionStep('actions/checkout')}\n        if: always()`),
    },
    {
      name: 'setup-node continue-on-error',
      workflow: (fixture) => fixture.replace(actionStep('actions/setup-node'), `${actionStep('actions/setup-node')}\n        continue-on-error: true`),
    },
    {
      name: 'npm ci if',
      workflow: (fixture) => fixture.replace('      - run: npm ci --ignore-scripts', '      - if: always()\n        run: npm ci --ignore-scripts'),
    },
    {
      name: 'Dev Containers CLI install continue-on-error',
      workflow: (fixture) => fixture.replace('      - run: npm install --global --ignore-scripts @devcontainers/cli@0.89.0', '      - continue-on-error: true\n        run: npm install --global --ignore-scripts @devcontainers/cli@0.89.0'),
    },
    {
      name: 'packed package install runs lifecycle scripts',
      workflow: (fixture) => fixture.replace(`npm install --ignore-scripts --prefix .packed-native ${packageInstallArchiveGlob}`, `npm install --prefix .packed-native ${packageInstallArchiveGlob}`),
    },
    {
      name: 'prerequisite if',
      workflow: (fixture) => fixture.replace('      - name: Require Docker, Dev Containers, and relative linked-worktree support', '      - name: Require Docker, Dev Containers, and relative linked-worktree support\n        if: always()'),
    },
    {
      name: 'live integration continue-on-error',
      workflow: (fixture) => fixture.replace('      - run: AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION=1 npm run test:integration', '      - continue-on-error: true\n        run: AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION=1 npm run test:integration'),
    },
  ];
  const liveDevcontainerGuardResults = [];
  for (const fixture of liveDevcontainerGuardFixtures) {
    await writeFixture(fixture.workflow(workflowFor(allSupportedArchitectures)));
    liveDevcontainerGuardResults.push({ ...fixture, result: verifyFixture() });
  }
  assert.ok(
    liveDevcontainerGuardResults.every(({ result }) => result.status !== 0),
    `the static packaging contract must reject every conditional or error-tolerant live-devcontainer gate:\n${liveDevcontainerGuardResults.map(({ name, result }) => `${name}: ${result.output}`).join('\n')}`,
  );

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

  await writeFixture(workflowFor(allSupportedArchitectures, '.', '.pack'));
  const hiddenArchiveDirectoryResult = verifyFixture();
  assert.notEqual(
    hiddenArchiveDirectoryResult.status,
    0,
    'the static packaging contract must reject staging the package tarball in hidden .pack because upload-artifact excludes hidden directories by default',
  );

  await writeFixture(workflowFor(allSupportedArchitectures, '.', packageArchiveDirectory, '\n          include-hidden-files: "true"'));
  const quotedTrueHiddenFilesResult = verifyFixture();
  assert.notEqual(
    quotedTrueHiddenFilesResult.status,
    0,
    'the static packaging contract must reject quoted string true because upload-artifact enables hidden-file uploads for that input',
  );

  for (const enabledHiddenFilesValue of ['True', 'TRUE', ' tRuE ']) {
    await writeFixture(workflowFor(allSupportedArchitectures, '.', packageArchiveDirectory, `\n          include-hidden-files: "${enabledHiddenFilesValue}"`));
    const caseVariantHiddenFilesResult = verifyFixture();
    assert.notEqual(
      caseVariantHiddenFilesResult.status,
      0,
      `the static packaging contract must reject quoted string ${enabledHiddenFilesValue} because upload-artifact enables hidden-file uploads for that input`,
    );
  }

  await writeFixture(workflowFor(allSupportedArchitectures, '.', packageArchiveDirectory, '\n          include-hidden-files: "false"'));
  const quotedFalseHiddenFilesResult = verifyFixture();
  assert.equal(
    quotedFalseHiddenFilesResult.status,
    0,
    `the static packaging contract must accept quoted string false because upload-artifact keeps hidden files excluded for that input:\n${quotedFalseHiddenFilesResult.output}`,
  );

  for (const acceptedHiddenFilesValue of ['false', '" FALSE "']) {
    await writeFixture(workflowFor(allSupportedArchitectures, '.', packageArchiveDirectory, `\n          include-hidden-files: ${acceptedHiddenFilesValue}`));
    const acceptedHiddenFilesResult = verifyFixture();
    assert.equal(
      acceptedHiddenFilesResult.status,
      0,
      `the static packaging contract must accept literal ${acceptedHiddenFilesValue} because it disables hidden-file uploads:\n${acceptedHiddenFilesResult.output}`,
    );
  }

  const unsafeHiddenFilesValues = ['${{ true }}', '${{ false }}', '0', '"no"'];
  for (const unsafeHiddenFilesValue of unsafeHiddenFilesValues) {
    await writeFixture(workflowFor(allSupportedArchitectures, '.', packageArchiveDirectory, `\n          include-hidden-files: ${unsafeHiddenFilesValue}`));
    const unsafeHiddenFilesResult = verifyFixture();
    assert.notEqual(
      unsafeHiddenFilesResult.status,
      0,
      `the static packaging contract must reject dynamic or non-literal-false include-hidden-files value ${unsafeHiddenFilesValue}`,
    );
  }

  const legacyPackageInstallWorkflow = workflowFor(allSupportedArchitectures).replace(
    `npm install --ignore-scripts --prefix .packed-native ${packageInstallArchiveGlob}`,
    `npm install --ignore-scripts --prefix .packed-native ${packageArchiveDirectory}/*.tgz`,
  );
  await writeFixture(legacyPackageInstallWorkflow);
  const legacyPackageInstallResult = verifyFixture();

  const correctedPackageInstallWorkflow = workflowFor(allSupportedArchitectures);
  await writeFixture(correctedPackageInstallWorkflow);
  const correctedPackageInstallResult = verifyFixture();
  assert.notEqual(
    legacyPackageInstallResult.status,
    0,
    'the static packaging contract must reject a non-prefixed tarball path because npm can parse it as a GitHub shorthand',
  );
  assert.equal(
    correctedPackageInstallResult.status,
    0,
    `the static packaging contract must accept the exact ./native-package/*.tgz filesystem path for portable bash npm installs:\n${correctedPackageInstallResult.output}`,
  );

  const packageAssemblyAndSmokeContractFixtures = [
    {
      name: 'assemble-native-package job if',
      workflow: (fixture) => fixture.replace('  assemble-native-package:\n', '  assemble-native-package:\n    if: always()\n'),
    },
    {
      name: 'assemble-native-package job continue-on-error',
      workflow: (fixture) => fixture.replace('  assemble-native-package:\n', '  assemble-native-package:\n    continue-on-error: true\n'),
    },
    {
      name: 'assemble-native-package decoy needs',
      workflow: (fixture) => fixture.replace('    needs: native-durability', '    needs: [native-durability, quality]'),
    },
    {
      name: 'assemble prebuild download if',
      workflow: (fixture) => fixture.replace(`${actionStep('actions/download-artifact')}\n        with:`, `${actionStep('actions/download-artifact')}\n        if: always()\n        with:`),
    },
    {
      name: 'assemble prebuild verification continue-on-error',
      workflow: (fixture) => fixture.replace('      - run: npm run native:verify-prebuilds', '      - continue-on-error: true\n        run: npm run native:verify-prebuilds'),
    },
    {
      name: 'assemble package command if',
      workflow: (fixture) => fixture.replace(`      - run: mkdir ${packageArchiveDirectory} && npm pack --pack-destination ${packageArchiveDirectory}`, `      - if: always()\n        run: mkdir ${packageArchiveDirectory} && npm pack --pack-destination ${packageArchiveDirectory}`),
    },
    {
      name: 'assemble tarball verification continue-on-error',
      workflow: (fixture) => fixture.replace(`      - run: node scripts/verify-native-package-tarball.mjs ${packageArchiveDirectory}/*.tgz`, `      - continue-on-error: true\n        run: node scripts/verify-native-package-tarball.mjs ${packageArchiveDirectory}/*.tgz`),
    },
    {
      name: 'assemble package upload if',
      workflow: (fixture) => fixture.replace(`${actionStep('actions/upload-artifact')}\n        with:\n          name: native-package`, `${actionStep('actions/upload-artifact')}\n        if: always()\n        with:\n          name: native-package`),
    },
    {
      name: 'native-package-smoke job if',
      workflow: (fixture) => fixture.replace('  native-package-smoke:\n', '  native-package-smoke:\n    if: always()\n'),
    },
    {
      name: 'native-package-smoke job continue-on-error',
      workflow: (fixture) => fixture.replace('  native-package-smoke:\n', '  native-package-smoke:\n    continue-on-error: true\n'),
    },
    {
      name: 'native-package-smoke decoy needs',
      workflow: (fixture) => fixture.replace('    needs: assemble-native-package', '    needs: [assemble-native-package, quality]'),
    },
    {
      name: 'smoke package download continue-on-error',
      workflow: (fixture) => fixture.replace(`${actionStep('actions/download-artifact')}\n        with:\n          name: native-package`, `${actionStep('actions/download-artifact')}\n        continue-on-error: true\n        with:\n          name: native-package`),
    },
    {
      name: 'smoke package installation if',
      workflow: (fixture) => fixture.replace(`      - run: mkdir .packed-native && npm install --ignore-scripts --prefix .packed-native ${packageInstallArchiveGlob}`, `      - if: always()\n        run: mkdir .packed-native && npm install --ignore-scripts --prefix .packed-native ${packageInstallArchiveGlob}`),
    },
    {
      name: 'removed production package smoke command',
      workflow: (fixture) => fixture.replace('      - run: node scripts/test-native.mjs\n        env:', '      - run: npm run build\n        env:'),
    },
    {
      name: 'conditional production package smoke command',
      workflow: (fixture) => fixture.replace('      - run: node scripts/test-native.mjs', '      - if: always()\n        run: node scripts/test-native.mjs'),
    },
    {
      name: 'production package smoke command continue-on-error',
      workflow: (fixture) => fixture.replace('      - run: node scripts/test-native.mjs', '      - continue-on-error: true\n        run: node scripts/test-native.mjs'),
    },
    {
      name: 'decoy production package smoke env',
      workflow: (fixture) => fixture.replace(
        '      - run: node scripts/test-native.mjs\n        env:',
        `      - run: node scripts/test-native.mjs\n        env:\n          PACKED_NATIVE_PACKAGE_DIR: ${'${{ github.workspace }}'}/wrong\n          EXPECTED_NATIVE_PUBLICATION_MODE: strict\n      - run: npm run build\n        env:`,
      ),
    },
  ];
  const packageAssemblyAndSmokeContractResults = [];
  for (const fixture of packageAssemblyAndSmokeContractFixtures) {
    await writeFixture(fixture.workflow(workflowFor(allSupportedArchitectures)));
    packageAssemblyAndSmokeContractResults.push({ ...fixture, result: verifyFixture() });
  }
  assert.ok(
    packageAssemblyAndSmokeContractResults.every(({ result }) => result.status !== 0),
    `the static packaging contract must reject every conditional, error-tolerant, decoy, or incomplete assembly/package-smoke workflow:\n${packageAssemblyAndSmokeContractResults.map(({ name, result }) => `${name}: ${result.output}`).join('\n')}`,
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
