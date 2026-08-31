import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, getContainerDetail, serializeContainer, toUserError } from './docker.js';
import { appendHistory, readHistory } from './history.js';

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

app.get('/api/dashboard', async (_req, res) => {
  try {
    await docker.ping();
    const containers = await docker.listContainers({ all: true });
    res.json({ connected: true, running: containers.filter(c => c.State === 'running').length, stopped: containers.filter(c => c.State !== 'running').length });
  } catch (error) { res.json({ connected: false, running: 0, stopped: 0, error: toUserError(error) }); }
});

app.get('/api/containers', async (_req, res) => {
  try { res.json((await docker.listContainers({ all: true })).map(serializeContainer)); }
  catch (error) { res.status(503).json({ error: toUserError(error) }); }
});

app.get('/api/containers/:id', async (req, res) => {
  try { res.json(await getContainerDetail(req.params.id)); }
  catch (error) { res.status(404).json({ error: toUserError(error, 'コンテナ詳細の取得') }); }
});

app.get('/api/containers/:id/logs', async (req, res) => {
  try {
    const logs = await docker.getContainer(req.params.id).logs({ stdout: true, stderr: true, tail: 500, timestamps: true });
    res.json({ logs: logs.toString('utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') });
  } catch (error) { res.status(500).json({ error: toUserError(error, 'ログの取得') }); }
});

app.post('/api/containers/:id/actions/:action', async (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: { message: '許可されていない操作です。' } });
  let name = id;
  try {
    const container = docker.getContainer(id);
    const inspected = await container.inspect();
    name = inspected.Name.replace(/^\//, '');
    await container[action]();
    const message = `コンテナ「${name}」を${({ start: '起動', stop: '停止', restart: '再起動' })[action]}しました。`;
    await appendHistory({ containerId: id, containerName: name, action, success: true, message });
    res.json({ message });
  } catch (error) {
    const formatted = toUserError(error, `コンテナの${action}`);
    await appendHistory({ containerId: id, containerName: name, action, success: false, message: formatted.message });
    res.status(500).json({ error: formatted });
  }
});

app.get('/api/history', async (_req, res) => {
  try { res.json(await readHistory()); }
  catch (error) { res.status(500).json({ error: toUserError(error, '操作履歴の読み込み') }); }
});

app.listen(process.env.PORT || 3000, () => console.log('Docker Management Tools: http://localhost:3000'));
