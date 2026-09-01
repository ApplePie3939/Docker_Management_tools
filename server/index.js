import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, getContainerDetail, serializeContainer, serializeComposeProjects, toUserError } from './docker.js';
import { appendHistory, readHistory } from './history.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localHost = '127.0.0.1';

export function decodeDockerLogBuffer(logBuffer) {
  const buffer = Buffer.isBuffer(logBuffer) ? logBuffer : Buffer.from(logBuffer);
  const chunks = [];
  let offset = 0;

  while (offset < buffer.length) {
    // Docker multiplexes stdout/stderr as: stream type, 3 reserved bytes,
    // then a 4-byte big-endian payload length. TTY logs are not multiplexed.
    if (offset + 8 > buffer.length ||
      ![1, 2].includes(buffer[offset]) ||
      buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
      return buffer.toString('utf8');
    }

    const payloadLength = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + payloadLength;
    if (payloadEnd > buffer.length) return buffer.toString('utf8');

    chunks.push(buffer.subarray(payloadStart, payloadEnd));
    offset = payloadEnd;
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function createApp({
  dockerClient = docker,
  getContainerDetailFn = getContainerDetail,
  appendHistoryFn = appendHistory,
  readHistoryFn = readHistory
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(root, 'public')));

  app.get('/api/dashboard', async (_req, res) => {
    try {
      await dockerClient.ping();
      const containers = await dockerClient.listContainers({ all: true });
      res.json({ connected: true, running: containers.filter(c => c.State === 'running').length, stopped: containers.filter(c => c.State !== 'running').length });
    } catch (error) { res.json({ connected: false, running: 0, stopped: 0, error: toUserError(error) }); }
  });

  app.get('/api/containers', async (_req, res) => {
    try { res.json((await dockerClient.listContainers({ all: true })).map(serializeContainer)); }
    catch (error) { res.status(503).json({ error: toUserError(error) }); }
  });

  app.get('/api/compose-projects', async (_req, res) => {
    try { res.json(serializeComposeProjects(await dockerClient.listContainers({ all: true }))); }
    catch (error) { res.status(503).json({ error: toUserError(error) }); }
  });

  app.get('/api/containers/:id', async (req, res) => {
    try { res.json(await getContainerDetailFn(req.params.id)); }
    catch (error) { res.status(404).json({ error: toUserError(error, 'コンテナ詳細の取得') }); }
  });

  app.get('/api/containers/:id/logs', async (req, res) => {
    try {
      const logs = await dockerClient.getContainer(req.params.id).logs({ stdout: true, stderr: true, tail: 500, timestamps: true });
      res.json({ logs: decodeDockerLogBuffer(logs) });
    } catch (error) { res.status(500).json({ error: toUserError(error, 'ログの取得') }); }
  });

  app.post('/api/containers/:id/actions/:action', async (req, res) => {
    const { id, action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: { message: '許可されていない操作です。' } });
    let name = id;
    try {
      const container = dockerClient.getContainer(id);
      const inspected = await container.inspect();
      name = inspected.Name.replace(/^\//, '');
      await container[action]();
      const message = `コンテナ「${name}」を${({ start: '起動', stop: '停止', restart: '再起動' })[action]}しました。`;
      try {
        await appendHistoryFn({ containerId: id, containerName: name, action, success: true, message });
        res.json({ message, historyRecorded: true });
      } catch (historyError) {
        console.error('操作履歴の保存に失敗しました。', historyError);
        res.json({
          message,
          historyRecorded: false,
          historyWarning: 'Docker操作は完了しましたが、操作履歴を保存できませんでした。'
        });
      }
    } catch (error) {
      const formatted = toUserError(error, `コンテナの${action}`);
      try {
        await appendHistoryFn({ containerId: id, containerName: name, action, success: false, message: formatted.message });
      } catch (historyError) {
        console.error('失敗した操作の履歴を保存できませんでした。', historyError);
      }
      res.status(500).json({ error: formatted });
    }
  });

  app.post('/api/compose-projects/:project/actions/:action', async (req, res) => {
    const { project, action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: { message: '許可されていない操作です。' } });
    try {
      const members = (await dockerClient.listContainers({ all: true })).filter(c => c.Labels?.['com.docker.compose.project'] === project);
      if (!members.length) return res.status(404).json({ error: { message: 'Composeプロジェクトが見つかりません。' } });
      const eligible = members.filter(c => action === 'start' ? ['created', 'exited'].includes(c.State) : c.State === 'running');
      const results = await Promise.all(eligible.map(async (member) => {
        const name = (member.Names?.[0] || member.Id).replace(/^\//, '');
        try {
          await dockerClient.getContainer(member.Id)[action]();
          const message = `Composeプロジェクト「${project}」のコンテナ「${name}」を${({ start: '起動', stop: '停止', restart: '再起動' })[action]}しました。`;
          try {
            await appendHistoryFn({ containerId: member.Id, containerName: name, action, success: true, message });
            return { id: member.Id, name, success: true, message, historyRecorded: true };
          } catch (historyError) {
            console.error('Compose操作履歴の保存に失敗しました。', historyError);
            return { id: member.Id, name, success: true, message, historyRecorded: false };
          }
        } catch (error) {
          const formatted = toUserError(error, `コンテナの${action}`);
          await appendHistoryFn({ containerId: member.Id, containerName: name, action, success: false, message: formatted.message }).catch(() => {});
          return { id: member.Id, name, success: false, message: formatted.message };
        }
      }));
      const succeeded = results.filter(result => result.success).length;
      const verb = ({ start: '起動', stop: '停止', restart: '再起動' })[action];
      res.json({ message: eligible.length ? `Composeプロジェクト「${project}」へ${verb}を実行しました（成功 ${succeeded}件、失敗 ${eligible.length - succeeded}件）。` : `Composeプロジェクト「${project}」に実行可能なコンテナはありません。`, results });
    } catch (error) { res.status(500).json({ error: toUserError(error, 'Composeプロジェクトの操作') }); }
  });

  app.get('/api/history', async (_req, res) => {
    try { res.json(await readHistoryFn()); }
    catch (error) { res.status(500).json({ error: toUserError(error, '操作履歴の読み込み') }); }
  });

  return app;
}

export function startServer(port = process.env.PORT || 3000) {
  const server = createApp().listen(port, localHost, () => {
    console.log(`Docker Management Tools: http://${localHost}:${server.address().port}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
