import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw new Error('package-lock.json must use npm lockfileVersion 3 with a packages map.');
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || typeof entry !== 'object' || entry === null || entry.link === true) continue;
  if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) throw new Error(`Locked package ${path} must resolve from https://registry.npmjs.org/.`);
  if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw new Error(`Locked package ${path} must carry a SHA-512 integrity hash.`);
}
