import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const requiredDirectories = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];
const root = resolve(process.cwd(), 'prebuilds');

async function hasNativeBinary(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.node')) return true;
    if (entry.isDirectory() && await hasNativeBinary(path)) return true;
  }
  return false;
}

const missing = [];
for (const directory of requiredDirectories) {
  try {
    if (!await hasNativeBinary(resolve(root, directory))) missing.push(directory);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') missing.push(directory);
    else throw error;
  }
}

if (missing.length > 0) {
  throw new Error(`Cross-platform native prebuilds are incomplete; missing .node binaries for: ${missing.join(', ')}. Assemble all CI native artifacts before packing.`);
}

process.stdout.write(`Verified native prebuild matrix: ${requiredDirectories.join(', ')}.\n`);
