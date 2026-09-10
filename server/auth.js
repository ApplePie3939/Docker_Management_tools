import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as oidc from 'openid-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eightHours = 8 * 60 * 60 * 1000;

function required(name, value = process.env[name]) {
  if (!value) throw new Error(`${name} must be configured before the server starts.`);
  return value;
}

function token() { return randomBytes(32).toString('base64url'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(item => item.trim().split(/=(.*)/s)).filter(([key]) => key).map(([key, value = '']) => [key, decodeURIComponent(value)]));
}

export function createSessionStore(databaseFile = path.join(root, 'data', 'auth.sqlite')) {
  mkdirSync(path.dirname(databaseFile), { recursive: true });
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL, name TEXT, email TEXT,
      csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS login_flows (
      state TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
  `);
  const cleanup = () => {
    const now = Date.now();
    database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    database.prepare('DELETE FROM login_flows WHERE expires_at <= ?').run(now);
  };
  return {
    createFlow() {
      cleanup();
      const flow = { state: token(), nonce: token(), codeVerifier: oidc.randomPKCECodeVerifier() };
      database.prepare('INSERT INTO login_flows (state, nonce, code_verifier, expires_at) VALUES (?, ?, ?, ?)').run(flow.state, flow.nonce, flow.codeVerifier, Date.now() + 10 * 60 * 1000);
      return flow;
    },
    takeFlow(state) {
      cleanup();
      const flow = database.prepare('SELECT nonce, code_verifier AS codeVerifier FROM login_flows WHERE state = ?').get(state);
      database.prepare('DELETE FROM login_flows WHERE state = ?').run(state);
      return flow;
    },
    createSession(identity) {
      cleanup();
      const value = token();
      const session = { ...identity, csrfToken: token(), createdAt: Date.now(), expiresAt: Date.now() + eightHours };
      database.prepare('INSERT INTO sessions (token_hash, subject, name, email, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(hash(value), session.subject, session.name || null, session.email || null, session.csrfToken, session.createdAt, session.expiresAt);
      return { value, session };
    },
    getSession(value) {
      if (!value) return undefined;
      cleanup();
      return database.prepare('SELECT subject, name, email, csrf_token AS csrfToken, created_at AS createdAt, expires_at AS expiresAt FROM sessions WHERE token_hash = ?').get(hash(value));
    },
    destroySession(value) { if (value) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(value)); },
    close() { database.close(); }
  };
}

export function oidcSettingsFromEnv(env = process.env) {
  return {
    issuer: required('OIDC_ISSUER', env.OIDC_ISSUER), clientId: required('OIDC_CLIENT_ID', env.OIDC_CLIENT_ID),
    clientSecret: required('OIDC_CLIENT_SECRET', env.OIDC_CLIENT_SECRET), redirectUri: required('OIDC_REDIRECT_URI', env.OIDC_REDIRECT_URI),
    allowedGroup: required('OIDC_ALLOWED_GROUP', env.OIDC_ALLOWED_GROUP), groupsClaim: env.OIDC_GROUPS_CLAIM || 'groups'
  };
}

function identityFromClaims(claims, settings) {
  if (!claims?.sub) throw new Error('IdP did not return a subject claim.');
  const groups = claims[settings.groupsClaim];
  const groupList = Array.isArray(groups) ? groups : typeof groups === 'string' ? [groups] : [];
  if (!groupList.includes(settings.allowedGroup)) {
    const error = new Error('このアカウントには利用権限がありません。'); error.code = 'FORBIDDEN'; throw error;
  }
  return { subject: claims.sub, name: claims.name || claims.preferred_username || '', email: claims.email || '' };
}

export function createOidcAuthenticator({ settings = oidcSettingsFromEnv(), store = createSessionStore(), client = oidc } = {}) {
  let configuration;
  async function config() {
    configuration ||= client.discovery(new URL(settings.issuer), settings.clientId, { client_secret: settings.clientSecret, redirect_uris: [settings.redirectUri], response_types: ['code'] });
    return configuration;
  }
  return {
    store,
    async login(req, res, next) {
      try {
        const flow = store.createFlow();
        const codeChallenge = await client.calculatePKCECodeChallenge(flow.codeVerifier);
        const destination = client.buildAuthorizationUrl(await config(), { redirect_uri: settings.redirectUri, scope: 'openid profile email', response_type: 'code', state: flow.state, nonce: flow.nonce, code_challenge: codeChallenge, code_challenge_method: 'S256' });
        res.redirect(destination.href);
      } catch (error) { next(error); }
    },
    async callback(req, res, next) {
      try {
        const flow = store.takeFlow(req.query.state);
        if (!flow) return res.status(400).send('ログイン要求が無効または期限切れです。もう一度ログインしてください。');
        const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        const tokens = await client.authorizationCodeGrant(await config(), callbackUrl, { pkceCodeVerifier: flow.codeVerifier, expectedState: req.query.state, expectedNonce: flow.nonce });
        let claims = tokens.claims();
        if ((!claims?.[settings.groupsClaim]) && tokens.access_token) {
          const userInfo = await client.fetchUserInfo(await config(), tokens.access_token, claims?.sub);
          claims = { ...claims, ...userInfo };
        }
        const { value } = store.createSession(identityFromClaims(claims, settings));
        res.cookie('dmt_session', value, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: eightHours });
        res.redirect('/');
      } catch (error) {
        if (error.code === 'FORBIDDEN') return res.status(403).send(error.message);
        next(error);
      }
    }
  };
}

export function createAuthMiddleware(authenticator) {
  const store = authenticator.store;
  const sessionFor = req => store.getSession(parseCookies(req.headers.cookie).dmt_session);
  const apiUnauthorized = res => res.status(401).json({ error: { message: '認証が必要です。', guidance: 'ログインしてからもう一度実行してください。' } });
  return {
    requireAuth(req, res, next) {
      const session = sessionFor(req);
      if (!session) return req.originalUrl.startsWith('/api/') ? apiUnauthorized(res) : res.redirect('/auth/login');
      req.auth = session;
      next();
    },
    me(req, res) { const { subject, name, email, csrfToken, expiresAt } = req.auth; res.json({ subject, name, email, csrfToken, expiresAt }); },
    logout(req, res) {
      const session = req.auth;
      if (req.get('origin') !== `${req.protocol}://${req.get('host')}` || req.get('x-csrf-token') !== session.csrfToken) return res.status(403).json({ error: { message: '無効なログアウト要求です。' } });
      store.destroySession(parseCookies(req.headers.cookie).dmt_session);
      res.clearCookie('dmt_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
      res.status(204).end();
    },
    csrf(req, res, next) {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
      if (req.get('origin') !== `${req.protocol}://${req.get('host')}` || req.get('x-csrf-token') !== req.auth.csrfToken) return res.status(403).json({ error: { message: '無効な操作要求です。画面を更新してもう一度実行してください。' } });
      next();
    }
  };
}
