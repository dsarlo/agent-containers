import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

const source = await readFile(new globalThis.URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const document = parseDocument(source, { uniqueKeys: true });
if (document.errors.length > 0) throw new Error(`Invalid .github/workflows/ci.yml: ${document.errors.map((error) => error.message).join('; ')}`);
if (document.warnings.length > 0) throw new Error(`Ambiguous .github/workflows/ci.yml: ${document.warnings.map((warning) => warning.message).join('; ')}`);
