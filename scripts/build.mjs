/* global process */
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

await rm('dist', { recursive: true, force: true });

const child = spawn(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
  shell: false,
  stdio: 'inherit',
});

const code = await new Promise((resolveCode, reject) => {
  child.once('error', reject);
  child.once('close', resolveCode);
});

if (code !== 0) process.exitCode = code ?? 1;
