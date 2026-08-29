import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(projectRoot, 'dist');
if (dist !== path.join(projectRoot, 'dist') || path.dirname(dist) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected path: ${dist}`);
}
fs.rmSync(dist, { recursive: true, force: true });
