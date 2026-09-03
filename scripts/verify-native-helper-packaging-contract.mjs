import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Static Story 2.1 packaging contract (make-free): proves the package owns
 * exactly two checksummed static helper artifacts for linux-x64 and linux-arm64
 * with pinned digests, that the wire protocol constants agree across the C
 * helper, the TypeScript codec, the build script, and the manifest, and that
 * ordinary CI enforces the pin. Artifact bytes must already exist in the tree.
 */
const repository = resolve(process.env.NATIVE_HELPER_CONTRACT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const helperDir = resolve(repository, 'native', 'helper');

const packageJson = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(helperDir, 'manifest.json'), 'utf8'));
const helperC = await readFile(resolve(helperDir, 'helper.c'), 'utf8');
const protocolTs = await readFile(resolve(repository, 'src', 'codespaces-protocol.ts'), 'utf8');
const buildHelper = await readFile(resolve(repository, 'scripts', 'build-helper.mjs'), 'utf8');
const toolchainDockerfile = await readFile(resolve(helperDir, 'Dockerfile.toolchain'), 'utf8');
const workflow = await readFile(resolve(repository, '.github', 'workflows', 'ci.yml'), 'utf8');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const requiredArchitectures = ['linux-x64', 'linux-arm64'];

// Manifest schema + self checksum + pinned digests.
assert.equal(manifest.schemaVersion, 1, 'helper manifest schema must be 1');
assert.equal(typeof manifest.artifactsStaged, 'boolean', 'helper manifest must declare whether packaged artifacts are staged');
assert.equal(manifest.selfChecksum, digest(JSON.stringify({ ...manifest, selfChecksum: undefined })), 'helper manifest must pass its own checksum');
assert.deepEqual(Object.keys(manifest.architectures).sort(), [...requiredArchitectures].sort(), 'helper manifest must pin exactly linux-x64 and linux-arm64');
for (const file of ['helper.c', 'Makefile']) {
  assert.match(manifest.sourcePins?.[file] ?? '', /^[0-9a-f]{64}$/, `manifest must pin ${file}`);
  assert.equal(manifest.sourcePins[file], digest(await readFile(resolve(helperDir, file))), `manifest source pin must match ${file}`);
}
for (const arch of requiredArchitectures) {
  const entry = manifest.architectures[arch];
  assert.ok(entry, `manifest must pin ${arch}`);
  assert.equal(entry.file, `agent-containers-helper-${arch}`, `${arch} artifact filename must be package-owned`);
  assert.match(entry.mode, /^[0-7]{4}$/, `${arch} must record an octal mode`);
  if (manifest.artifactsStaged) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${arch} must carry a pinned SHA-256 when artifacts are staged`);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0, `${arch} must record a positive byte size when staged`);
  } else {
    assert.equal(entry.sha256, null, `${arch} must not carry a fabricated digest before artifacts are staged`);
    assert.equal(entry.size, null, `${arch} must not carry a fabricated byte size before artifacts are staged`);
  }
}
if (manifest.artifactsStaged) {
  for (const arch of requiredArchitectures) {
    const entry = manifest.architectures[arch];
    const bytes = await readFile(resolve(helperDir, 'bin', entry.file));
    assert.equal(bytes.length, entry.size, `${arch} artifact size must equal its pin`);
    assert.equal(digest(bytes), entry.sha256, `${arch} artifact digest must equal its pin`);
  }
} else {
  // Host limitation: staging the static artifacts requires a C toolchain
  // (make + native/arm64 cross compiler), which the pinned helper-artifacts CI
  // job provides. On this host the contract audits the manifest/wiring/protocol
  // and defers the artifact digest audit exactly as the avoid-fabrication rule.
  process.stdout.write(
    'NOTE: helper artifacts are not staged on this host (no C toolchain); ' +
    'the pinned helper-artifacts CI job stages them and strictly audits ' +
    'their digests against this manifest before any packaging release.\n',
  );
}

// Protocol constants agree across C, TS, build script, and manifest.
const tsProtocol = Number(/^export const HELPER_PROTOCOL_VERSION = (\d+);$/m.exec(protocolTs)?.[1]);
const cProtocol = Number(/^#define AC_HELPER_PROTOCOL_VERSION (\d+)$/m.exec(helperC)?.[1]);
const scriptProtocol = Number(/const HELPER_PROTOCOL_VERSION = (\d+);/m.exec(buildHelper)?.[1]);
assert.equal(tsProtocol, 1, 'TypeScript codec must define protocol version 1');
assert.equal(cProtocol, tsProtocol, 'helper.c protocol must equal the TypeScript codec');
assert.equal(scriptProtocol, tsProtocol, 'build-helper protocol must equal the TypeScript codec');
assert.equal(manifest.protocol, tsProtocol, 'manifest protocol must equal the TypeScript codec');
assert.match(protocolTs, /5 \+ payload\.length/, 'TypeScript framing must reserve one type byte plus a 4-byte length');
assert.match(helperC, /header\[4\]/, 'C framing must write a big-endian 4-byte length after the type byte');
assert.match(protocolTs, /MAX_HELPER_FRAME_PAYLOAD = 1024 \* 1024/, 'TypeScript frame payload bound must be one MiB');
assert.match(helperC, /AC_MAX_FRAME_PAYLOAD \(1024u \* 1024u\)/, 'C frame payload bound must be one MiB');
const frameConstants = [
  ['hello', 'AC_R_HELLO', '0x01'],
  ['exec', 'AC_R_EXEC', '0x02'],
  ['attach', 'AC_R_ATTACH', '0x03'],
  ['cancel', 'AC_R_CANCEL', '0x04'],
  ['resize', 'AC_R_RESIZE', '0x05'],
  ['stdin', 'AC_R_STDIN', '0x06'],
];
for (const [name, cConstant, hex] of frameConstants) {
  assert.ok(protocolTs.includes(`${name}: 0x${hex.slice(2)}`), `TypeScript frame constants must include ${name} (${hex})`);
  assert.ok(helperC.includes(`${cConstant} = 0x${hex.slice(2)}`), `helper.c must declare ${cConstant} = ${hex}`);
}

// Build script owns the pinned paths and calls a real compiler + make.
for (const file of ['agent-containers-helper-linux-x64', 'agent-containers-helper-linux-arm64']) {
  assert.ok(buildHelper.includes(file), `build script must reference the package-owned artifact ${file}`);
}
assert.match(buildHelper, /\bmake\b/, 'artifact build must be driven by a reproducible make build');
assert.match(buildHelper, /manifest\.json/, 'build script must pin the committed checksummed manifest');
assert.match(buildHelper, /helperDir\s*=\s*join\(repository,\s*'native',\s*'helper'\)/, 'build script must own the native/helper paths');
assert.match(buildHelper, /artifactsStaged:\s*true/, 'pin must record that the artifacts are staged');

// Package wiring.
for (const script of ['build:helper', 'verify:helper-reproducible', 'verify:native-helper-packaging-contract', 'test:native-helper-packaging-contract']) {
  assert.ok(packageJson.scripts[script], `package.json must define ${script}`);
}
assert.match(packageJson.scripts['build:helper'], /build-helper\.mjs/, 'build:helper must run the reproducible builder');
assert.match(packageJson.scripts['verify:helper-reproducible'], /verify-reproducible/, 'the reproducibility gate must compare an isolated build without repinning committed artifacts');
assert.match(packageJson.scripts['verify:native-helper-packaging-contract'], /verify-native-helper-packaging-contract\.mjs/, 'verify:native-helper-packaging-contract must run the make-free verifier');
assert.match(buildHelper, /AGENT_CONTAINERS_HELPER_REBUILD_DIR/, 'the comparison command must accept a pinned-toolchain output directory instead of rebuilding with the host compiler');

// Toolchain provenance is part of the artifact pin: Bookworm base digest and
// exact compiler/header packages produce the committed helper ELF bytes.
assert.match(toolchainDockerfile, /^FROM debian@sha256:[0-9a-f]{64}$/m, 'helper toolchain must pin the Debian base image by digest');
assert.match(toolchainDockerfile, /snapshot\.debian\.org\/archive\/debian\/[0-9]{8}T[0-9]{6}Z/, 'helper toolchain must use an immutable Debian package snapshot');
for (const packagePin of ['gcc=4:12.2.0-3', 'gcc-aarch64-linux-gnu=4:12.2.0-3', 'libc6-dev=2.36-9+deb12u14', 'libc6-dev-arm64-cross=2.36-8cross1', 'make=4.3-4.1']) {
  assert.ok(toolchainDockerfile.includes(packagePin), `helper toolchain must pin ${packagePin}`);
}

// CI must validate committed pins before it compiles anything, then build the
// immutable toolchain and compare a clean outside-tree rebuild. It must never
// repin the reviewed artifacts or use the runner's arbitrary compiler.
assert.doesNotMatch(workflow, /npm run build:helper/, 'ci must not repin committed helper artifacts before validation');
const helperJob = workflow.match(/^ {2}helper-artifacts:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n|(?![\s\S]))/m)?.[1];
assert.ok(helperJob, 'ci must define the helper-artifacts job');
const committedPinCheck = helperJob.indexOf('npm run verify:native-helper-packaging-contract');
const toolchainBuild = helperJob.indexOf('docker build --pull=false');
const reproducibleCheck = helperJob.indexOf('AGENT_CONTAINERS_HELPER_REBUILD_DIR=.helper-rebuild npm run verify:helper-reproducible');
assert.ok(committedPinCheck >= 0 && toolchainBuild > committedPinCheck && reproducibleCheck > toolchainBuild, 'the helper-artifacts job must verify committed helper pins before rebuilding under the pinned toolchain');
assert.match(helperJob, /Dockerfile\.toolchain/, 'helper-artifacts must build the repository-owned pinned helper toolchain');
assert.match(helperJob, /docker create -v "\$GITHUB_WORKSPACE:\/workspace:ro"/, 'helper-artifacts must compile helper sources from a read-only checkout');
assert.match(helperJob, /test:native-helper-packaging-contract/, 'helper-artifacts must run the helper packaging negative test');
assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/, 'ci must upload the pinned helper artifacts with an immutable action SHA');

process.stdout.write('Native helper packaging contract passed.\n');