import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOidcAuthenticator, createSessionStore } from './auth.js';
import { createApp } from './index.js';

async function startAuthenticatedApp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dmt-auth-'));
  const store = createSessionStore(path.join(directory, 'auth.sqlite'), { legacyHistoryFile: path.join(directory, 'history.json') });
  store.setUser({ subject: 'user-1', role: 'viewer' });
  const server = createApp({
    authenticator: { store, login: (_req, res) => res.status(501).end(), callback: (_req, res) => res.status(501).end() },
    dockerClient: { ping: async () => {}, listContainers: async () => [] }, readHistoryFn: async () => []
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, store };
}

test('authentication protects pages and APIs, and logout invalidates the server session', async (t) => {
  const { baseUrl, store } = await startAuthenticatedApp(t);
  const anonymousApi = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(anonymousApi.status, 401);
  assert.equal((await anonymousApi.json()).error.message, '認証が必要です。');
  const anonymousPage = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(anonymousPage.status, 302);
  assert.equal(anonymousPage.headers.get('location'), '/auth/login');

  const { value, session } = store.createSession({ subject: 'user-1', name: '開発者', email: 'dev@example.test' });
  const cookie = `dmt_session=${value}`;
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  const identity = await me.json();
  assert.equal(identity.subject, 'user-1'); assert.equal(identity.role, 'viewer'); assert.equal(identity.host.id, 'shared-docker-host'); assert.equal(identity.csrfToken, session.csrfToken);

  const missingCsrf = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie, Origin: baseUrl } });
  assert.equal(missingCsrf.status, 403);
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie, Origin: baseUrl, 'X-CSRF-Token': session.csrfToken } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } })).status, 401);
});

test('state-changing Docker APIs require same-origin CSRF validation', async (t) => {
  const { baseUrl, store } = await startAuthenticatedApp(t);
  const { value, session } = store.createSession({ subject: 'user-1' });
  const headers = { cookie: `dmt_session=${value}` };
  assert.equal((await fetch(`${baseUrl}/api/containers/x/actions/start`, { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/containers/x/actions/start`, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example', 'X-CSRF-Token': session.csrfToken } })).status, 403);
});

test('roles limit Docker operations and administrators manage users and audit records', async (t) => {
  const { baseUrl, store } = await startAuthenticatedApp(t);
  const viewer = store.createSession({ subject: 'user-1' });
  const viewerHeaders = { cookie: `dmt_session=${viewer.value}`, Origin: baseUrl, 'X-CSRF-Token': viewer.session.csrfToken };
  assert.equal((await fetch(`${baseUrl}/api/containers/x/actions/start`, { method: 'POST', headers: viewerHeaders })).status, 403);
  store.setUser({ subject: 'admin-1', role: 'admin' });
  const admin = store.createSession({ subject: 'admin-1' });
  const headers = { cookie: `dmt_session=${admin.value}`, Origin: baseUrl, 'X-CSRF-Token': admin.session.csrfToken, 'Content-Type': 'application/json' };
  const saved = await fetch(`${baseUrl}/api/admin/users/operator-1`, { method: 'PUT', headers, body: JSON.stringify({ role: 'operator', name: '操作者' }) });
  assert.equal(saved.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/admin/users`, { headers })).status, 200);
  const host = await fetch(`${baseUrl}/api/admin/host`, { method: 'PUT', headers, body: JSON.stringify({ displayName: '共有ホストA' }) });
  assert.equal(host.status, 200);
  const audit = await (await fetch(`${baseUrl}/api/admin/audit`, { headers })).json();
  assert.equal(audit.total, 2);
});

test('legacy history migrates once into the SQLite audit ledger', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dmt-migration-'));
  const databaseFile = path.join(directory, 'auth.sqlite'), historyFile = path.join(directory, 'history.json');
  await fs.writeFile(historyFile, JSON.stringify([{ at: '2026-01-01T00:00:00.000Z', containerName: 'web', action: 'start', success: true, message: 'started' }]));
  const store = createSessionStore(databaseFile, { legacyHistoryFile: historyFile });
  assert.equal(store.queryAudit().total, 1);
  store.close();
  await fs.writeFile(historyFile, JSON.stringify([{ containerName: 'must-not-import' }]));
  const reopened = createSessionStore(databaseFile, { legacyHistoryFile: historyFile });
  assert.equal(reopened.queryAudit().total, 1);
  reopened.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test('OIDC callback validates PKCE, state and nonce before creating an allowed session', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dmt-oidc-'));
  const store = createSessionStore(path.join(directory, 'auth.sqlite'), { legacyHistoryFile: path.join(directory, 'history.json') });
  store.setUser({ subject: 'oidc-user', role: 'admin' });
  let expected, callbackBase;
  const client = {
    randomPKCECodeVerifier: () => 'verifier', calculatePKCECodeChallenge: async value => `challenge-${value}`,
    discovery: async () => ({}),
    buildAuthorizationUrl: (_config, parameters) => { expected = parameters; return new URL(`https://idp.example/authorize?state=${parameters.state}`); },
    authorizationCodeGrant: async (_config, callback, checks) => {
      assert.equal(callback.href, `${callbackBase}/auth/callback?code=ok&state=${expected.state}`);
      assert.equal(typeof checks.pkceCodeVerifier, 'string');
      assert.equal(checks.expectedState, expected.state);
      assert.equal(checks.expectedNonce, expected.nonce);
      return { claims: () => ({ sub: 'oidc-user', name: 'OIDC User', groups: ['docker-management-users'] }) };
    }
  };
  const authenticator = createOidcAuthenticator({
    store, client,
    settings: { issuer: 'https://idp.example', clientId: 'client', clientSecret: 'secret', redirectUri: 'https://127.0.0.1/auth/callback', allowedGroup: 'docker-management-users', groupsClaim: 'groups' }
  });
  const server = createApp({ authenticator, dockerClient: { ping: async () => {}, listContainers: async () => [] }, readHistoryFn: async () => [] }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  callbackBase = `https://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const callback = await fetch(`${baseUrl}/auth/callback?code=ok&state=${expected.state}`, { redirect: 'manual', headers: { Host: '127.0.0.1', 'X-Forwarded-Proto': 'https' } });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('set-cookie'), /dmt_session=/);
  const reused = await fetch(`${baseUrl}/auth/callback?code=ok&state=${expected.state}`, { redirect: 'manual' });
  assert.equal(reused.status, 400);
});
