import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const file = path.join(dataDir, 'history.json');
const maxEntries = 1000;

function corruptFileName(historyFile, id) {
  const parsed = path.parse(historyFile);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(parsed.dir, `${parsed.name}.corrupt-${timestamp}-${id}${parsed.ext}`);
}

export function createHistoryStore(historyFile = file, { fileSystem = fs } = {}) {
  let queue = Promise.resolve();

  function runExclusive(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function recoverCorruptHistory() {
    const archivedFile = corruptFileName(historyFile, randomUUID());
    await fileSystem.rename(historyFile, archivedFile);
    return [];
  }

  async function readHistoryFile() {
    let contents;
    try {
      contents = await fileSystem.readFile(historyFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    try {
      const history = JSON.parse(contents);
      if (!Array.isArray(history)) throw new TypeError('操作履歴は配列である必要があります。');
      return history;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return recoverCorruptHistory();
      throw error;
    }
  }

  async function writeHistory(history) {
    const temporaryFile = `${historyFile}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fileSystem.open(temporaryFile, 'wx');
      await handle.writeFile(JSON.stringify(history, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fileSystem.rename(temporaryFile, historyFile);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fileSystem.unlink(temporaryFile).catch(() => {});
      throw error;
    }
  }

  function readHistory() {
    return runExclusive(readHistoryFile);
  }

  function appendHistory(entry) {
    return runExclusive(async () => {
      await fileSystem.mkdir(path.dirname(historyFile), { recursive: true });
      const history = await readHistoryFile();
      history.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry });
      await writeHistory(history.slice(0, maxEntries));
    });
  }

  return { readHistory, appendHistory };
}

const defaultStore = createHistoryStore();
export const { readHistory, appendHistory } = defaultStore;
