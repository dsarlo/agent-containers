import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import process from 'node:process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = resolve(repository, 'scripts/verify-native-helper-packaging-contract.mjs');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-containers-native-helper-contract-'));

const filesToMirror = [
  ['native/helper/Dockerfile.toolchain'],
  ['native/helper/manifest.json'],
  ['native/helper/helper.c'],
  ['native/helper/Makefile'],
  ['native/helper/bin/agent-containers-helper-linux-x64'],
  ['native/helper/bin/agent-containers-helper-linux-arm64'],
  ['src/codespaces-protocol.ts'],
  ['scripts/build-helper.mjs'],
  ['.github/workflows/ci.yml'],
  ['package.json'],
];

async function writeFixture(mutate) {
  const root = join(fixtureRoot, `case-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'native', 'helper', 'bin'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [relative] of filesToMirror) {
    const source = join(repository, relative);
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { force: true });
  }
  await mutate(root);
  return root;
}

function verifyFixture(root) {
  try {
    execFileSync(process.execPath, [verifier], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, NATIVE_HELPER_CONTRACT_ROOT: root },
      stdio: 'pipe',
    });
    return { status: 0, output: '' };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function rewriteManifest(root, mutate) {
  const path = join(root, 'native', 'helper', 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await mutate(manifest);
  manifest.selfChecksum = createHash('sha256').update(JSON.stringify({ ...manifest, selfChecksum: undefined })).digest('hex');
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

try {
  {
    // Baseline: the real repository mirror must pass.
    const root = await writeFixture(async () => undefined);
    const result = verifyFixture(root);
    assert.equal(result.status, 0, `the helper packaging contract must accept the real tree:\n${result.output}`);
  }

  const failingCases = [
    {
      name: 'arm64 entry removed from manifest',
      mutate: async (root) => {
        await rewriteManifest(root, (manifest) => { delete manifest.architectures['linux-arm64']; });
      },
    },
    {
      name: 'manifest self checksum corrupted',
      mutate: async (root) => {
        const path = join(root, 'native', 'helper', 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.selfChecksum = '0'.repeat(64);
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      },
    },
    {
      name: 'a staged manifest whose artifact fails its pinned digest',
      mutate: async (root) => {
        const manifest = await rewriteManifest(root, (value) => { void value; });
        manifest.artifactsStaged = true;
        const fresh = createHash('sha256').update(JSON.stringify({ ...manifest, selfChecksum: undefined })).digest('hex');
        manifest.selfChecksum = fresh;
        await writeFile(join(root, 'native', 'helper', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const path = join(root, 'native', 'helper', 'bin', 'agent-containers-helper-linux-x64');
        await writeFile(path, 'tampered artifact bytes');
      },
    },
    {
      name: 'an unstaged manifest carrying a fabricated digest',
      mutate: async (root) => {
        const manifest = await rewriteManifest(root, (value) => {
          value.architectures['linux-x64'].sha256 = 'f'.repeat(64);
          value.architectures['linux-x64'].size = 12345;
        });
        await writeFile(join(root, 'native', 'helper', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      },
    },
    {
      name: 'manifest protocol disagrees with the codec',
      mutate: async (root) => {
        await rewriteManifest(root, (manifest) => { manifest.protocol = 2; });
      },
    },
    {
      name: 'helper.c protocol constant disagrees with the codec',
      mutate: async (root) => {
        const path = join(root, 'native', 'helper', 'helper.c');
        const source = (await readFile(path, 'utf8')).replace('AC_HELPER_PROTOCOL_VERSION 1', 'AC_HELPER_PROTOCOL_VERSION 2');
        await writeFile(path, source, 'utf8');
      },
    },
    {
      name: 'TypeScript protocol constant disagrees with the manifest',
      mutate: async (root) => {
        const path = join(root, 'src', 'codespaces-protocol.ts');
        const source = (await readFile(path, 'utf8')).replace('export const HELPER_PROTOCOL_VERSION = 1;', 'export const HELPER_PROTOCOL_VERSION = 2;');
        await writeFile(path, source, 'utf8');
      },
    },
    {
      name: 'package.json drops the packaging contract script',
      mutate: async (root) => {
        const path = join(root, 'package.json');
        const pkg = JSON.parse(await readFile(path, 'utf8'));
        delete pkg.scripts['verify:native-helper-packaging-contract'];
        await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      },
    },
    {
      name: 'helper CI rebuilds with an arbitrary host compiler instead of the pinned toolchain',
      mutate: async (root) => {
        const path = join(root, '.github', 'workflows', 'ci.yml');
        const workflow = await readFile(path, 'utf8');
        await writeFile(path, workflow.replace(/docker build --pull=false/, 'CC=gcc CC_ARM64=aarch64-linux-gnu-gcc'));
      },
    },
    {
      name: 'a helper CI job that rebuilds and repins committed artifacts before verification',
      mutate: async (root) => {
        const path = join(root, '.github', 'workflows', 'ci.yml');
        const workflow = await readFile(path, 'utf8');
        await writeFile(path, workflow.replace(/npm run verify:helper-reproducible/, 'npm run build:helper'));
      },
    },
    {
      name: 'ci.yml drops the isolated helper reproducibility check and immutable upload',
      mutate: async (root) => {
        const path = join(root, '.github', 'workflows', 'ci.yml');
        const workflow = (await readFile(path, 'utf8'))
          .replace(/npm run verify:helper-reproducible/, 'npm run build')
          .replace(/actions\/upload-artifact@[0-9a-f]{40}/, 'actions/upload-artifact@v4');
        await writeFile(path, workflow, 'utf8');
      },
    },
  ];

  for (const fixture of failingCases) {
    const root = await writeFixture(fixture.mutate);
    const result = verifyFixture(root);
    assert.notEqual(result.status, 0, `the helper packaging contract must reject ${fixture.name}`);
  }

  process.stdout.write('Native helper packaging contract policy regression passed.\n');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
  void sha256;
  void repository;
}