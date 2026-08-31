import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const file = path.join(dataDir, 'history.json');

export function createHistoryStore(historyFile = file) {
  async function readHistory() {
    try { return JSON.parse(await fs.readFile(historyFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function appendHistory(entry) {
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    const history = await readHistory();
    history.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry });
    await fs.writeFile(historyFile, JSON.stringify(history.slice(0, 1000), null, 2), 'utf8');
  }

  return { readHistory, appendHistory };
}

const defaultStore = createHistoryStore();
export const { readHistory, appendHistory } = defaultStore;
