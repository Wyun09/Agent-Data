const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { listenProxy } = require('@agent-data/proxy');
const { listFilesRecursive, readJson } = require('@agent-data/storage');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agent-data-'));
}

async function waitFor(file, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { return await fsp.readFile(file, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`timed out waiting for ${file}`);
}

test('proxy forwards request and SSE chunks while recording sanitized raw data', async (t) => {
  const dataDir = await tempDir();
  let upstreamBody = '';
  let upstreamAuth = '';
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      upstreamBody = Buffer.concat(chunks).toString('utf8');
      upstreamAuth = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      const chunksToSend = [
        'event: response.created\ndata: {"id":"resp_test","status":"in_progress"}\n\n',
        'event: response.output_text.delta\ndata: {"response_id":"resp_test","delta":"Hello"}\n\n',
        'event: response.output_text.delta\ndata: {"response_id":"resp_test","delta":" world"}\n\n',
        'event: response.completed\ndata: {"id":"resp_test","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}\n\n'
      ];
      let index = 0;
      const timer = setInterval(() => {
        if (index === chunksToSend.length) {
          clearInterval(timer);
          response.end();
          return;
        }
        response.write(chunksToSend[index++]);
      }, 8);
      response.on('close', () => clearInterval(timer));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await listenProxy({ upstream: upstreamUrl, port: 0, dataDir });
  t.after(() => proxy.close());

  const body = JSON.stringify({ model: 'gpt-5.6', stream: true, input: 'Fix it', tools: [{ type: 'function', name: 'shell' }] });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer super-secret-test-token',
      'x-api-key': 'sk-test-key-1234567890',
      'x-agent-data-session-id': 'proxy-session-1'
    },
    body
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Hello/);
  assert.match(text, /world/);
  assert.equal(upstreamBody, body);
  assert.equal(upstreamAuth, 'Bearer super-secret-test-token');

  const sessionFile = path.join(dataDir, 'sessions', 'proxy-session-1.json');
  const session = JSON.parse(await waitFor(sessionFile));
  assert.equal(session.provider.protocol, 'openai-responses');
  assert.match(session.turns[0].response.text, /Hello world/);
  assert.equal(session.turns[0].usage.output_tokens, 2);

  const rawFiles = await listFilesRecursive(path.join(dataDir, 'raw'), '.jsonl');
  assert.equal(rawFiles.length, 1);
  const rawText = await fsp.readFile(rawFiles[0], 'utf8');
  assert.ok(rawText.includes('sse_event'));
  assert.ok(!rawText.includes('super-secret-test-token'));
  assert.ok(!rawText.includes('sk-test-key-1234567890'));
  assert.ok(rawText.includes('[REDACTED]'));
});

test('proxy turns upstream failures into a recorded error', async (t) => {
  const dataDir = await tempDir();
  const upstream = http.createServer((request, response) => {
    response.destroy();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const proxy = await listenProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0, dataDir });
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, { method: 'POST', body: '{}' });
  assert.ok([502, 200].includes(response.status));
  const sessionFile = path.join(dataDir, 'sessions');
  const start = Date.now();
  let files = [];
  while (Date.now() - start < 3000 && !files.length) {
    files = await listFilesRecursive(sessionFile, '.json');
    if (!files.length) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(files.length, 1);
  const session = await readJson(files[0]);
  assert.ok(session.events.some((event) => event.type === 'error'));
});

test('client cancellation is recorded without crashing the proxy', async (t) => {
  const dataDir = await tempDir();
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: response.output_text.delta\ndata: {"delta":"first"}\n\n');
      const timer = setInterval(() => response.write('event: response.output_text.delta\ndata: {"delta":"later"}\n\n'), 20);
      response.on('close', () => clearInterval(timer));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const proxy = await listenProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0, dataDir });
  t.after(() => proxy.close());
  await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: proxy.address().port, path: '/v1/responses', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-data-session-id': 'cancel-session' }
    }, (response) => {
      response.once('data', () => { request.destroy(); resolve(); });
      response.on('error', () => {});
    });
    request.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    request.end('{}');
  });
  const filesRoot = path.join(dataDir, 'sessions');
  const start = Date.now();
  let files = [];
  while (Date.now() - start < 3000 && !files.length) {
    files = await listFilesRecursive(filesRoot, '.json');
    if (!files.length) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(files.length, 1);
  const session = await readJson(files[0]);
  assert.ok(session.events.some((event) => event.type === 'error'));
});
