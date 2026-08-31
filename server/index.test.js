import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { decodeDockerLogBuffer, startServer } from './index.js';

function dockerFrame(stream, text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
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
