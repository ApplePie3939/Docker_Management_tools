import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const file = path.join(dataDir, 'history.json');

export async function readHistory() {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function appendHistory(entry) {
  await fs.mkdir(dataDir, { recursive: true });
  const history = await readHistory();
  history.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry });
  await fs.writeFile(file, JSON.stringify(history.slice(0, 1000), null, 2), 'utf8');
}
