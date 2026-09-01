import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const testDirectory = resolve('dist/test');
const testFiles = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => join(testDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled test files found in ${testDirectory}`);
}

const child = spawn(process.execPath, ['--import', './dist/test/setup.js', '--test', ...testFiles], {
  shell: false,
  stdio: 'inherit',
});

const code = await new Promise((resolveCode, reject) => {
  child.once('error', reject);
  child.once('close', resolveCode);
});

if (code !== 0) process.exitCode = code ?? 1;
