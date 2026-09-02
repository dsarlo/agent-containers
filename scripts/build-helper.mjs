/* global process */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HELPER_PROTOCOL_VERSION = 1; // mirrors src/codespaces-protocol.ts; the packaging contract cross-checks both.

/**
 * Reproducible helper artifact builder (Story 2.1).
 *
 *   node scripts/build-helper.mjs build                 # make both artifacts
 *   node scripts/build-helper.mjs pin                   # build then pin manifest
 *   node scripts/build-helper.mjs pin --verify-only     # pin committed binaries if present
 *   node scripts/build-helper.mjs verify                # contract + digest checks
 *
 * `make` and a native/arm64 cross toolchain are required for the build path
 * (this host without a C toolchain reports the limitation and never fabricates
 * a digest). The verification contract is make-free and must stay green.
 */
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helperDir = join(repository, 'native', 'helper');
const manifestPath = join(helperDir, 'manifest.json');
const binDir = join(helperDir, 'bin');
const archArtifacts = {
  'linux-x64': 'agent-containers-helper-linux-x64',
  'linux-arm64': 'agent-containers-helper-linux-arm64',
};


export function manifestSelfChecksum(manifest) {
  return createHash('sha256').update(JSON.stringify({ ...manifest, selfChecksum: undefined })).digest('hex');
}

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sourcePins() {
  const helperC = await readFile(join(helperDir, 'helper.c'));
  const makefile = await readFile(join(helperDir, 'Makefile'));
  return { 'helper.c': digest(helperC), Makefile: digest(makefile) };
}

export async function build(outputDir = binDir) {
  if (!process.env.CI && !(await stat('/usr/bin/make')).isFile()) {
    throw new Error('make is unavailable; the static helper artifact requires a C toolchain (run this inside the pinned helper-artifacts CI job or a toolchain host).');
  }
  execFileSync('make', ['-C', helperDir, `BIN_DIR=${outputDir}`], { stdio: 'inherit' });
}

async function statSize(path) {
  const entry = await stat(path);
  if (!entry.isFile()) throw new Error(`helper artifact ${path} is not a regular file`);
  return entry.size;
}

export async function pin({ verifyOnly = false } = {}) {
  for (const file of Object.values(archArtifacts)) {
    if (verifyOnly) {
      const path = join(binDir, file);
      await stat(path); // must exist
    }
  }
  if (!verifyOnly) await build();
  const architectures = {};
  for (const [arch, file] of Object.entries(archArtifacts)) {
    const path = join(binDir, file);
    const bytes = await readFile(path);
    architectures[arch] = {
      file,
      sha256: digest(bytes),
      size: bytes.length,
      mode: '0755',
    };
  }
  const manifest = {
    schemaVersion: 1,
    protocol: HELPER_PROTOCOL_VERSION,
    helperVersion: '0.1.0',
    architectures,
    sourcePins: await sourcePins(),
    artifactsStaged: true,
    selfChecksum: '',
    generatedAt: new Date().toISOString(),
  };
  manifest.selfChecksum = manifestSelfChecksum(manifest);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function verify() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.selfChecksum !== manifestSelfChecksum(manifest)) throw new Error('helper manifest fails its own checksum');
  for (const [arch, file] of Object.entries(archArtifacts)) {
    if (Object.keys(manifest.architectures ?? {}).sort().join(',') !== Object.keys(archArtifacts).sort().join(',')) {
      throw new Error('helper manifest must pin exactly linux-x64 and linux-arm64');
    }
    const path = join(binDir, file);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch {
      throw new Error(`helper artifact ${file} is absent; run the pinned build (requires make + toolchain)`);
    }
    const entry = manifest.architectures[arch];
    if (!entry || entry.sha256 !== digest(bytes) || entry.size !== bytes.length) {
      throw new Error(`helper artifact ${file} does not match its pinned digest; refusing a tampered artifact`);
    }
    await statSize(path);
  }
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length === 0) throw new Error('empty manifest');
  void randomUUID;
  return manifest;
}

/** Build outside the repository and compare the output to the committed pins. */
export async function verifyReproducible() {
  const manifest = await verify();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-containers-helper-rebuild-'));
  const outputDir = join(temporaryRoot, 'bin');
  try {
    await build(outputDir);
    for (const [arch, file] of Object.entries(archArtifacts)) {
      const bytes = await readFile(join(outputDir, file));
      const entry = manifest.architectures[arch];
      if (!entry || entry.sha256 !== digest(bytes) || entry.size !== bytes.length) {
        throw new Error(`isolated helper rebuild for ${file} does not match the committed pinned digest; refusing to repin CI output.`);
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const [subcommand] = process.argv.slice(2);
  const verifyOnly = process.argv.includes('--verify-only');
  let result;
  switch (subcommand) {
    case 'build':
      await build();
      result = `Built ${Object.entries(archArtifacts).map(([arch, file]) => `${arch}=${binDir}/${file}`).join(', ')}.`;
      break;
    case 'pin':
      result = `Pinned ${JSON.stringify((await pin({ verifyOnly })).architectures, null, 2)}`;
      break;
    case 'verify':
      result = `Helper artifacts and manifest verified against pinned digests.`;
      await verify();
      break;
    case 'verify-reproducible':
      await verifyReproducible();
      result = 'Isolated helper rebuild matches committed pinned digests.';
      break;
    default:
      throw new Error('usage: node scripts/build-helper.mjs <build|pin|verify|verify-reproducible> [--verify-only]');
  }
  process.stdout.write(`${result}\n`);
}

await main();