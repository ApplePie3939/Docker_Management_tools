import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { startServer } from './index.js';

test('HTTP server listens only on the IPv4 loopback address', async (t) => {
  const server = startServer(0);
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  assert.equal(address.address, '127.0.0.1');

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
});
