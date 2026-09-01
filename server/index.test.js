import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, decodeDockerLogBuffer, startServer } from './index.js';
import { createHistoryStore } from './history.js';
import { serializeContainer, toUserError } from './docker.js';

function dockerFrame(stream, text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function startTestApp(t, dependencies) {
  const server = createApp(dependencies).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function json(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

test('Docker multiplexed stdout and stderr logs are decoded without frame headers', () => {
  const logs = Buffer.concat([
    dockerFrame(1, '2026-08-31T00:00:00Z started\n'),
    dockerFrame(2, '2026-08-31T00:00:01Z error: 接続できません\n'),
    dockerFrame(1, '2026-08-31T00:00:02Z stopped\n')
  ]);

  assert.equal(
    decodeDockerLogBuffer(logs),
    '2026-08-31T00:00:00Z started\n2026-08-31T00:00:01Z error: 接続できません\n2026-08-31T00:00:02Z stopped\n'
  );
});

test('non-multiplexed TTY logs are preserved unchanged', () => {
  const logs = Buffer.from('2026-08-31T00:00:00Z interactive shell\n', 'utf8');

  assert.equal(decodeDockerLogBuffer(logs), logs.toString('utf8'));
});

test('an empty Docker log buffer returns an empty string', () => {
  assert.equal(decodeDockerLogBuffer(Buffer.alloc(0)), '');
});

test('HTTP server listens only on the IPv4 loopback address', async (t) => {
  const server = startServer(0);
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  assert.equal(address.address, '127.0.0.1');

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
});

test('Docker API routes return dashboard, container list, details, and decoded logs', async (t) => {
  const logCalls = [];
  const dockerClient = {
    ping: async () => {},
    listContainers: async () => [{
      Id: 'abc123', Names: ['/web'], Image: 'nginx:latest', State: 'running', Status: 'Up 5 minutes',
      Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '127.0.0.1' }]
    }],
    getContainer: () => ({
      logs: async (options) => {
        logCalls.push(options);
        return Buffer.concat([dockerFrame(1, 'started\n'), dockerFrame(2, 'warning\n')]);
      }
    })
  };
  const detail = { id: 'abc123', name: 'web', image: 'nginx:latest', state: 'running', environment: [], ports: [], mounts: [] };
  const baseUrl = await startTestApp(t, { dockerClient, getContainerDetailFn: async () => detail, readHistoryFn: async () => [] });

  assert.deepEqual((await json(`${baseUrl}/api/dashboard`)).body, { connected: true, running: 1, stopped: 0 });
  assert.deepEqual((await json(`${baseUrl}/api/containers`)).body, [{
    id: 'abc123', name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 5 minutes',
    ports: [{ privatePort: 80, publicPort: 8080, type: 'tcp', ip: '127.0.0.1' }]
  }]);
  assert.deepEqual((await json(`${baseUrl}/api/containers/abc123`)).body, detail);
  assert.deepEqual((await json(`${baseUrl}/api/containers/abc123/logs`)).body, { logs: 'started\nwarning\n' });
  assert.deepEqual(logCalls, [{ stdout: true, stderr: true, tail: 500, timestamps: true }]);
});

test('Docker API routes provide user-facing errors when Docker calls fail', async (t) => {
  const unavailable = Object.assign(new Error('connect ENOENT docker_engine'), { code: 'ENOENT' });
  const dockerClient = {
    ping: async () => { throw unavailable; },
    listContainers: async () => { throw unavailable; },
    getContainer: () => ({ logs: async () => { throw unavailable; } })
  };
  const baseUrl = await startTestApp(t, {
    dockerClient,
    getContainerDetailFn: async () => { throw unavailable; },
    readHistoryFn: async () => { throw unavailable; }
  });

  const dashboard = await json(`${baseUrl}/api/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.connected, false);
  assert.match(dashboard.body.error.guidance, /Docker Desktop/);
  assert.equal((await json(`${baseUrl}/api/containers`)).status, 503);
  assert.equal((await json(`${baseUrl}/api/containers/abc123`)).status, 404);
  assert.equal((await json(`${baseUrl}/api/containers/abc123/logs`)).status, 500);
  assert.equal((await json(`${baseUrl}/api/history`)).status, 500);
});

test('container actions invoke Docker and record both successful and failed history entries', async (t) => {
  const history = [];
  const calls = [];
  const dockerClient = {
    getContainer: (id) => ({
      inspect: async () => ({ Name: '/web' }),
      start: async () => { calls.push(`${id}:start`); },
      stop: async () => { throw new Error('container is already stopped'); },
      restart: async () => { calls.push(`${id}:restart`); }
    })
  };
  const baseUrl = await startTestApp(t, { dockerClient, appendHistoryFn: async (entry) => history.push(entry) });

  const started = await json(`${baseUrl}/api/containers/abc123/actions/start`, { method: 'POST' });
  assert.equal(started.status, 200);
  assert.match(started.body.message, /コンテナ「web」を起動しました/);
  assert.equal(started.body.historyRecorded, true);
  const restarted = await json(`${baseUrl}/api/containers/abc123/actions/restart`, { method: 'POST' });
  assert.equal(restarted.status, 200);
  assert.match(restarted.body.message, /コンテナ「web」を再起動しました/);
  assert.equal((await json(`${baseUrl}/api/containers/abc123/actions/delete`, { method: 'POST' })).status, 400);
  const stopped = await json(`${baseUrl}/api/containers/abc123/actions/stop`, { method: 'POST' });
  assert.equal(stopped.status, 500);
  assert.match(stopped.body.error.message, /already stopped/);
  assert.deepEqual(calls, ['abc123:start', 'abc123:restart']);
  assert.deepEqual(history.map(entry => [entry.action, entry.success, entry.containerName]), [
    ['start', true, 'web'], ['restart', true, 'web'], ['stop', false, 'web']
  ]);
});

test('container actions preserve Docker results when history persistence fails', async (t) => {
  const dockerClient = {
    getContainer: () => ({
      inspect: async () => ({ Name: '/web' }),
      start: async () => {},
      stop: async () => { throw new Error('container is already stopped'); }
    })
  };
  const baseUrl = await startTestApp(t, {
    dockerClient,
    appendHistoryFn: async () => { throw new Error('disk full'); }
  });

  const started = await json(`${baseUrl}/api/containers/abc123/actions/start`, { method: 'POST' });
  assert.equal(started.status, 200);
  assert.equal(started.body.historyRecorded, false);
  assert.match(started.body.historyWarning, /操作履歴を保存できませんでした/);

  const stopped = await json(`${baseUrl}/api/containers/abc123/actions/stop`, { method: 'POST' });
  assert.equal(stopped.status, 500);
  assert.match(stopped.body.error.message, /already stopped/);
});

test('history store persists entries in reverse chronological order and caps them at 1000', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-management-tools-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createHistoryStore(path.join(directory, 'history.json'));

  assert.deepEqual(await store.readHistory(), []);
  await store.appendHistory({ containerId: 'first', action: 'start', success: true, message: 'first' });
  await store.appendHistory({ containerId: 'second', action: 'stop', success: false, message: 'second' });
  const saved = await store.readHistory();
  assert.equal(saved.length, 2);
  assert.equal(saved[0].containerId, 'second');
  assert.match(saved[0].id, /^[0-9a-f-]{36}$/);
  assert.match(saved[0].at, /^\d{4}-\d{2}-\d{2}T/);

  await fs.writeFile(path.join(directory, 'history.json'), JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({ id: String(index) }))));
  await store.appendHistory({ containerId: 'latest', action: 'restart', success: true, message: 'latest' });
  assert.equal((await store.readHistory()).length, 1000);
});

test('history store serializes concurrent appends and ignores stale temporary files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-management-tools-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const historyFile = path.join(directory, 'history.json');
  const store = createHistoryStore(historyFile);
  await fs.writeFile(`${historyFile}.interrupted.tmp`, '{not a history file}', 'utf8');

  await Promise.all(Array.from({ length: 1005 }, (_, index) => store.appendHistory({
    containerId: String(index), action: 'start', success: true, message: String(index)
  })));

  const history = await store.readHistory();
  assert.equal(history.length, 1000);
  assert.deepEqual(history.map(entry => entry.containerId), Array.from({ length: 1000 }, (_, index) => String(1004 - index)));
  assert.deepEqual(JSON.parse(await fs.readFile(historyFile, 'utf8')), history);
  assert.equal(await fs.readFile(`${historyFile}.interrupted.tmp`, 'utf8'), '{not a history file}');
});

test('history store quarantines malformed history and propagates quarantine and write failures', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-management-tools-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const historyFile = path.join(directory, 'history.json');
  await fs.writeFile(historyFile, '{broken', 'utf8');
  const store = createHistoryStore(historyFile);

  assert.deepEqual(await store.readHistory(), []);
  const names = await fs.readdir(directory);
  const corruptFile = names.find(name => /^history\.corrupt-.*\.json$/.test(name));
  assert.ok(corruptFile);
  assert.equal(await fs.readFile(path.join(directory, corruptFile), 'utf8'), '{broken');

  await store.appendHistory({ containerId: 'fresh', action: 'start', success: true, message: 'fresh' });
  assert.equal((await store.readHistory())[0].containerId, 'fresh');

  await fs.writeFile(historyFile, '{broken again', 'utf8');
  const failingStore = createHistoryStore(historyFile, {
    fileSystem: { ...fs, rename: async () => { throw new Error('archive unavailable'); } }
  });
  await assert.rejects(failingStore.readHistory(), /archive unavailable/);
  assert.equal(await fs.readFile(historyFile, 'utf8'), '{broken again');

  await fs.writeFile(historyFile, JSON.stringify([{ id: 'preserved' }]), 'utf8');
  await assert.rejects(failingStore.appendHistory({ containerId: 'new' }), /archive unavailable/);
  assert.deepEqual(JSON.parse(await fs.readFile(historyFile, 'utf8')), [{ id: 'preserved' }]);

  const unwritableHistoryFile = path.join(directory, 'history-directory');
  await fs.mkdir(unwritableHistoryFile);
  await assert.rejects(createHistoryStore(unwritableHistoryFile).appendHistory({}), /EISDIR/);
});

test('container serialization and Docker error guidance are safe for missing optional fields', () => {
  assert.deepEqual(serializeContainer({ Id: 'id', Image: 'image', State: 'exited', Status: 'Exited', Ports: [] }), {
    id: 'id', name: '', image: 'image', state: 'exited', status: 'Exited', ports: []
  });
  assert.match(toUserError(new Error('permission EACCES')).guidance, /Docker Desktop/);
  assert.match(toUserError(new Error('not found'), 'コンテナの停止').guidance, /コンテナの停止に失敗/);
});
