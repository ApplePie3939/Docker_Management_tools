import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { createApp } from '../server/index.js';

let server;
let baseUrl;

function container(id, name, state, labels = {}) {
  return { Id: id, Names: [`/${name}`], Image: 'example:latest', State: state, Status: state === 'running' ? 'Up 1 minute' : 'Exited (0)', Ports: [], Labels: labels };
}

test.beforeAll(async () => {
  const listed = [
    container('web', 'web', 'running', { 'com.docker.compose.project': 'sample' }),
    container('worker', 'worker', 'exited', { 'com.docker.compose.project': 'sample' })
  ];
  const dockerClient = {
    ping: async () => {},
    listContainers: async () => listed,
    getContainer: (id) => ({
      inspect: async () => ({ Name: `/${id}`, Config: { Image: 'example:latest', Env: ['PORT=3000'] }, State: { Status: id === 'web' ? 'running' : 'exited' }, HostConfig: { PortBindings: {} }, Mounts: [] }),
      logs: async () => Buffer.from('application started\n'),
      start: async () => {}, stop: async () => {}, restart: async () => {}
    })
  };
  server = createApp({
    dockerClient,
    getContainerDetailFn: async (id) => ({ id, name: id, image: 'example:latest', state: id === 'web' ? 'running' : 'exited', environment: ['PORT=3000'], ports: [], mounts: [] }),
    readHistoryFn: async () => [],
    appendHistoryFn: async () => {}
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test('lists, filters, opens details, and confirms a container operation', async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.getByText('● 接続済み')).toBeVisible();
  await expect(page.getByRole('button', { name: 'web' })).toBeVisible();
  await page.locator('#state-filter').selectOption('exited');
  await expect(page.getByRole('button', { name: 'worker' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'web' })).not.toBeVisible();
  await page.getByRole('button', { name: 'worker' }).click();
  await expect(page.getByRole('heading', { name: 'worker' })).toBeVisible();
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: '起動', exact: true }).click();
  await expect(page.getByText('コンテナ「worker」を起動します。よろしいですか？')).toBeVisible();
  await page.getByRole('button', { name: '実行する' }).click();
  await expect(page.locator('#toast')).toContainText('コンテナ「worker」を起動しました');
});

test('shows compose projects and confirms a project operation', async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.getByRole('heading', { name: 'Composeプロジェクト' })).toBeVisible();
  await expect(page.getByText('sample', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '一括再起動' }).click();
  await expect(page.getByText('Composeプロジェクト「sample」の実行可能な既存コンテナを一括再起動します。よろしいですか？')).toBeVisible();
});

test('shows Docker connection guidance when the daemon is unavailable', async ({ page }) => {
  const unavailable = Object.assign(new Error('connect ENOENT docker_engine'), { code: 'ENOENT' });
  const failedServer = createApp({ dockerClient: { ping: async () => { throw unavailable; } }, readHistoryFn: async () => [] }).listen(0, '127.0.0.1');
  await once(failedServer, 'listening');
  try {
    await page.goto(`http://127.0.0.1:${failedServer.address().port}`);
    await expect(page.getByText('● 接続できません')).toBeVisible();
    await expect(page.getByText(/Docker Desktop/)).toBeVisible();
  } finally {
    failedServer.closeAllConnections();
    failedServer.close();
  }
});
