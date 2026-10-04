const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { SSEParser } = require('@agent-data/core/sse');
const { RawEventRecorder, finalizeRawSession } = require('@agent-data/recorder');
const { assertId, contextPath, resolveDataDir } = require('@agent-data/storage');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function copyForwardHeaders(headers, target) {
  const result = {};
  const excluded = String(headers.connection || '').toLowerCase().split(',').map((name) => name.trim());
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || excluded.includes(lower) ||
        ['host', 'content-length', 'x-agent-data-session-id'].includes(lower)) continue;
    result[name] = value;
  }
  result.host = target.host;
  return result;
}

function requestBodyValue(buffer, contentType = '') {
  const text = buffer.toString('utf8');
  if (contentType.includes('json')) {
    try { return JSON.parse(text); } catch { /* preserve malformed text */ }
  }
  return text;
}

function makeTargetUrl(upstream, incomingUrl) {
  const base = new URL(upstream);
  const request = new URL(incomingUrl || '/', 'http://agent-data.invalid');
  const prefix = base.pathname.replace(/\/$/, '');
  if (!prefix || prefix === '/' || request.pathname === prefix || request.pathname.startsWith(prefix + '/')) {
    base.pathname = request.pathname;
  } else base.pathname = prefix + '/' + request.pathname.replace(/^\/+/, '');
  base.search = request.search;
  return base;
}

function responseHeaders(headers) {
  const excluded = String(headers.connection || '').toLowerCase().split(',').map((name) => name.trim());
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !HOP_BY_HOP.has(name.toLowerCase()) && !excluded.includes(name.toLowerCase())));
}

function readSessionContext(dataDir, sessionId) {
  try { return JSON.parse(fs.readFileSync(contextPath(dataDir, sessionId), 'utf8')); } catch { return null; }
}

function createProxyServer(options = {}) {
  if (!options.upstream) throw new TypeError('upstream is required');
  const upstream = new URL(options.upstream);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new TypeError('upstream must use http or https');
  const transport = upstream.protocol === 'https:' ? https : http;
  const dataDir = resolveDataDir(options.dataDir);
  const privacyMode = options.privacyMode || 'safe';
  const provider = options.provider || 'openai-responses';
  const states = new Map();
  const pending = new Set();
  const maxCapture = options.maxCaptureBytes || 8 * 1024 * 1024;

  const server = http.createServer((clientRequest, clientResponse) => {
    let sessionId;
    try {
      sessionId = assertId(String(clientRequest.headers['x-agent-data-session-id'] || options.defaultSessionId || crypto.randomUUID()), 'session id');
    } catch {
      clientResponse.writeHead(400, { 'content-type': 'application/json' });
      clientResponse.end(JSON.stringify({ error: 'invalid_session_id' }));
      clientRequest.resume();
      return;
    }
    const startedAt = new Date();
    const requestId = crypto.randomUUID();
    let state = states.get(sessionId);
    if (!state) {
      const context = readSessionContext(dataDir, sessionId);
      const recorder = new RawEventRecorder({
        sessionId, dataDir, privacyMode, startedAt: context?.created_at || startedAt.toISOString(),
        maxQueue: options.maxRecorderQueue, maxQueueBytes: options.maxRecorderQueueBytes
      });
      state = { recorder, tail: Promise.resolve(), active: 0 };
      states.set(sessionId, state);
      void recorder.record('session_start', {
        session_id: sessionId, provider,
        agent: context?.agent || null, environment: context?.environment || {},
        metadata: context?.metadata || {}, privacy_mode: privacyMode
      }, { timestamp: startedAt.toISOString() });
    }
    state.active += 1;
    const { recorder } = state;
    const record = (kind, payload = {}) => recorder.record(kind, payload, { requestId, turnId: requestId });
    void record('http_request_start', { method: clientRequest.method, url: clientRequest.url });
    clientResponse.setHeader('x-agent-data-session-id', sessionId);
    let finalized = false;
    let responseEnded = false;
    let clientClosed = false;
    let upstreamRequest;
    let firstByteAt;

    const finish = (kind, payload = {}) => {
      if (finalized) return;
      finalized = true;
      state.active -= 1;
      void record(kind, payload);
      void recorder.record('session_end', {
        recording_incomplete: recorder.incomplete, open_requests: state.active
      });
      state.tail = state.tail.then(async () => {
        await recorder.flush();
        await finalizeRawSession({ dataDir, file: recorder.file, sessionId, privacyMode, normalizer: options.normalizer });
      }).catch((error) => process.emitWarning('agent-data canonicalization: ' + error.message));
      const task = state.tail;
      pending.add(task);
      void task.finally(() => pending.delete(task));
    };
    const cancel = () => {
      clientClosed = true;
      finish('client_disconnect', { message: 'client disconnected' });
      upstreamRequest?.destroy();
    };
    clientRequest.on('aborted', cancel);
    clientRequest.on('error', cancel);
    clientResponse.on('close', () => { if (!responseEnded) cancel(); });

    const target = makeTargetUrl(options.upstream, clientRequest.url);
    upstreamRequest = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, method: clientRequest.method,
      headers: copyForwardHeaders(clientRequest.headers, target),
      rejectUnauthorized: options.rejectUnauthorized
    }, (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers['content-type'] || '');
      const encoding = String(upstreamResponse.headers['content-encoding'] || '').toLowerCase();
      const statusCode = upstreamResponse.statusCode || 502;
      clientResponse.writeHead(statusCode, { ...responseHeaders(upstreamResponse.headers), 'x-agent-data-session-id': sessionId });
      clientResponse.flushHeaders();
      void record('response_start', { status_code: statusCode, headers: upstreamResponse.headers, content_type: contentType });
      const parser = contentType.includes('text/event-stream') ? new (options.sseParser || SSEParser)() : null;
      let captured = 0;
      let body = [];
      let decoder;
      const decodedData = (chunk) => {
        if (parser) {
          for (const event of parser.feed(chunk)) void record('sse_event', event);
        } else if (captured + chunk.length <= maxCapture) {
          body.push(Buffer.from(chunk));
          captured += chunk.length;
        } else {
          body = [];
          captured = maxCapture + 1;
          recorder.incomplete = true;
        }
      };
      const decodedEnd = () => {
        if (parser) {
          for (const event of parser.finish()) void record('sse_event', event);
        } else if (captured <= maxCapture && /json|text/.test(contentType)) {
          void record('response_body', { body: requestBodyValue(Buffer.concat(body), contentType), status_code: statusCode });
        } else {
          void record('response_body_omitted', { reason: captured > maxCapture ? 'capture_limit' : 'binary_content', content_type: contentType });
        }
        const endedAt = new Date();
        finish('response_end', {
          status_code: statusCode, latency_ms: endedAt - startedAt,
          time_to_first_token_ms: firstByteAt ? firstByteAt - startedAt : null,
          content_type: contentType
        });
      };
      if (encoding === 'gzip') decoder = zlib.createGunzip();
      else if (encoding === 'deflate') decoder = zlib.createInflate();
      else if (encoding === 'br') decoder = zlib.createBrotliDecompress();
      else if (encoding && encoding !== 'identity') {
        recorder.incomplete = true;
        void record('capture_error', { code: 'unsupported_encoding', encoding });
      }
      if (decoder) {
        decoder.on('data', decodedData);
        decoder.on('end', decodedEnd);
        decoder.on('error', (error) => {
          recorder.incomplete = true;
          finish('capture_error', { message: error.message });
        });
      }
      upstreamResponse.on('data', (chunk) => {
        firstByteAt ||= new Date();
        if (!clientClosed && !clientResponse.write(chunk)) upstreamResponse.pause();
        if (decoder) decoder.write(chunk);
        else if (!encoding || encoding === 'identity') decodedData(chunk);
      });
      clientResponse.on('drain', () => upstreamResponse.resume());
      upstreamResponse.on('end', () => {
        responseEnded = true;
        if (!clientClosed) clientResponse.end();
        if (decoder) decoder.end();
        else decodedEnd();
      });
      const failure = (error) => {
        finish('upstream_error', { code: error?.code || 'upstream_response_aborted', message: error?.message });
        responseEnded = true;
        if (!clientClosed) clientResponse.end();
        decoder?.destroy();
      };
      upstreamResponse.on('aborted', failure);
      upstreamResponse.on('error', failure);
    });
    if (options.timeoutMs) upstreamRequest.setTimeout(options.timeoutMs, () =>
      upstreamRequest.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    upstreamRequest.on('error', (error) => {
      finish('upstream_error', { code: error.code, message: error.message });
      responseEnded = true;
      if (clientClosed) return;
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, { 'content-type': 'application/json' });
        clientResponse.end(JSON.stringify({ error: 'upstream_error', message: error.message }));
      } else clientResponse.end();
    });

    const requestChunks = [];
    let requestBytes = 0;
    clientRequest.on('data', (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes <= maxCapture) requestChunks.push(Buffer.from(chunk));
      else { requestChunks.length = 0; recorder.incomplete = true; }
      if (!upstreamRequest.destroyed && !upstreamRequest.write(chunk)) clientRequest.pause();
    });
    upstreamRequest.on('drain', () => clientRequest.resume());
    clientRequest.on('end', () => {
      void record('request', {
        method: clientRequest.method, url: clientRequest.url, headers: clientRequest.headers,
        body: requestBytes <= maxCapture ? requestBodyValue(Buffer.concat(requestChunks), String(clientRequest.headers['content-type'] || '')) : null,
        capture_incomplete: requestBytes > maxCapture, provider
      });
      if (!upstreamRequest.destroyed) upstreamRequest.end();
    });
  });
  server.agentData = {
    upstream: options.upstream, dataDir, privacyMode, provider,
    drain: async () => {
      await Promise.all([...pending]);
      await Promise.all([...states.values()].map((state) => state.recorder.flush()));
    }
  };
  return server;
}

async function listenProxy(options = {}) {
  const server = createProxyServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port === undefined ? 8787 : Number(options.port), options.host || '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

module.exports = { createProxyServer, listenProxy, makeTargetUrl, copyForwardHeaders, readSessionContext };
