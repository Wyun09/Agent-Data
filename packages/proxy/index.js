const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { SSEParser } = require('@agent-data/core/sse');
const { RawEventRecorder, finalizeRawSession } = require('@agent-data/recorder');
const { assertId, contextPath, resolveDataDir } = require('@agent-data/storage');
const { responsesToChat, ChatToResponses, encodeEvent } = require('@agent-data/protocol-openai/chat-bridge');
const { inspectDangerousCommands } = require('@agent-data/safety');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
const END_TO_END_AUTH_HEADER = 'authorization';

function copyForwardHeaders(headers, target) {
  const result = {};
  const excluded = String(headers.connection || '').toLowerCase().split(',').map((name) => name.trim());
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || (excluded.includes(lower) && lower !== END_TO_END_AUTH_HEADER) ||
        ['host', 'content-length', 'x-agent-data-session-id'].includes(lower)) continue;
    result[name] = value;
  }
  // Authorization is an end-to-end header. Keep it even when a malformed
  // client Connection header incorrectly lists it as hop-by-hop.
  const authorization = headers.authorization ?? headers.Authorization;
  if (authorization !== undefined) result.authorization = authorization;
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
  // The ChatGPT login backend is not the API-key /v1 endpoint. Codex still
  // talks to our local /v1 provider, so remove that local prefix upstream.
  if (prefix.endsWith('/backend-api/codex') && request.pathname.startsWith('/v1/')) {
    request.pathname = request.pathname.slice(3);
  }
  if (!prefix || prefix === '/' || request.pathname === prefix || request.pathname.startsWith(prefix + '/')) {
    base.pathname = request.pathname;
  } else base.pathname = prefix + '/' + request.pathname.replace(/^\/+/, '');
  base.search = request.search;
  return base;
}

function isModelsProbe(method, incomingUrl) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  try {
    const pathname = new URL(incomingUrl || '/', 'http://agent-data.invalid').pathname.replace(/\/+$/, '') || '/';
    return pathname === '/v1/models' || pathname.endsWith('/v1/models');
  } catch {
    return false;
  }
}

function isResponsesToChatBridge(method, incomingUrl, mode) {
  if (mode !== 'responses-to-chat' || String(method || '').toUpperCase() !== 'POST') return false;
  try {
    const pathname = new URL(incomingUrl || '/', 'http://agent-data.invalid').pathname.replace(/\/+$/, '');
    return pathname === '/v1/responses' || pathname.endsWith('/v1/responses');
  } catch {
    return false;
  }
}

function responseHeaders(headers) {
  const excluded = String(headers.connection || '').toLowerCase().split(',').map((name) => name.trim());
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !HOP_BY_HOP.has(name.toLowerCase()) && !excluded.includes(name.toLowerCase())));
}

function readSessionContext(dataDir, sessionId) {
  try { return JSON.parse(fs.readFileSync(contextPath(dataDir, sessionId), 'utf8')); } catch { return null; }
}

function passthroughRequest(clientRequest, clientResponse, options, transport) {
  const target = makeTargetUrl(options.upstream, clientRequest.url);
  const upstreamRequest = transport.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method: clientRequest.method,
    headers: copyForwardHeaders(clientRequest.headers, target),
    rejectUnauthorized: options.rejectUnauthorized
  }, (upstreamResponse) => {
    clientResponse.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(clientResponse);
    upstreamResponse.on('aborted', () => clientResponse.destroy());
    upstreamResponse.on('error', () => clientResponse.destroy());
  });
  if (options.timeoutMs) upstreamRequest.setTimeout(options.timeoutMs, () =>
    upstreamRequest.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
  upstreamRequest.on('error', (error) => {
    if (clientResponse.destroyed) return;
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, { 'content-type': 'application/json' });
      clientResponse.end(JSON.stringify({ error: 'upstream_error', message: error.message }));
    } else clientResponse.end();
  });
  clientRequest.on('aborted', () => upstreamRequest.destroy());
  clientRequest.on('error', () => upstreamRequest.destroy());
  clientRequest.pipe(upstreamRequest);
  return upstreamRequest;
}

function createProxyServer(options = {}) {
  if (!options.upstream) throw new TypeError('upstream is required');
  const upstream = new URL(options.upstream);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new TypeError('upstream must use http or https');
  const transport = upstream.protocol === 'https:' ? https : http;
  const dataDir = resolveDataDir(options.dataDir);
  const privacyMode = options.privacyMode || 'safe';
  const provider = options.provider || 'openai-responses';
  const protocolBridge = options.protocolBridge || options.protocol_bridge || 'off';
  const states = new Map();
  const pending = new Set();
  const maxCapture = options.maxCaptureBytes || 8 * 1024 * 1024;
  const stats = {
    started_at: new Date().toISOString(),
    requests: 0,
    responses: 0,
    sessions: 0,
    captured_events: 0,
    safety_findings: 0,
    last_activity: null
  };

  const server = http.createServer((clientRequest, clientResponse) => {
    // Codex's daemon calls GET /v1/models before it has a conversation. Keep
    // this capability probe completely transparent: it must retain the
    // login Authorization header and must not create a training session.
    if (isModelsProbe(clientRequest.method, clientRequest.url)) {
      passthroughRequest(clientRequest, clientResponse, options, transport);
      return;
    }
    let sessionId;
    try {
      sessionId = assertId(String(clientRequest.headers['x-agent-data-session-id'] ||
        clientRequest.headers['thread-id'] || clientRequest.headers['session-id'] ||
        clientRequest.headers['x-codex-thread-id'] || options.defaultSessionId || crypto.randomUUID()), 'session id');
    } catch {
      clientResponse.writeHead(400, { 'content-type': 'application/json' });
      clientResponse.end(JSON.stringify({ error: 'invalid_session_id' }));
      clientRequest.resume();
      return;
    }
    const startedAt = new Date();
    const requestId = crypto.randomUUID();
    stats.requests += 1;
    stats.last_activity = startedAt.toISOString();
    let state = states.get(sessionId);
    if (!state) {
      const context = readSessionContext(dataDir, sessionId);
      const recorder = new RawEventRecorder({
        sessionId, dataDir, privacyMode, startedAt: context?.created_at || startedAt.toISOString(),
        maxQueue: options.maxRecorderQueue, maxQueueBytes: options.maxRecorderQueueBytes
      });
      state = { recorder, tail: Promise.resolve(), active: 0 };
      states.set(sessionId, state);
      stats.sessions += 1;
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
        const finalizedSession = await finalizeRawSession({ dataDir, file: recorder.file, sessionId, privacyMode, normalizer: options.normalizer });
        if (options.onSessionFinalized) await options.onSessionFinalized(finalizedSession);
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

    const bridgeRequest = isResponsesToChatBridge(clientRequest.method, clientRequest.url, protocolBridge);
    const bridgeState = { request: null, customTools: new Set(), response_body: [] };
    const target = makeTargetUrl(options.upstream, clientRequest.url);
    if (bridgeRequest) target.pathname = target.pathname.replace(/\/responses(?=\?|$)/, '/chat/completions');
    const forwardHeaders = copyForwardHeaders(clientRequest.headers, target);
    if (bridgeRequest) {
      forwardHeaders['accept-encoding'] = 'identity';
      forwardHeaders['content-type'] = 'application/json';
    }
    upstreamRequest = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, method: clientRequest.method,
      headers: forwardHeaders,
      rejectUnauthorized: options.rejectUnauthorized
    }, (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers['content-type'] || '');
      const encoding = String(upstreamResponse.headers['content-encoding'] || '').toLowerCase();
      const statusCode = upstreamResponse.statusCode || 502;
      const bridgeResponse = bridgeRequest && statusCode < 400;
      const bridgeStreaming = bridgeResponse && contentType.includes('text/event-stream');
      const outgoingContentType = bridgeResponse
        ? (bridgeState.request?.stream === false ? 'application/json' : 'text/event-stream')
        : contentType;
      const outgoingHeaders = { ...responseHeaders(upstreamResponse.headers), 'x-agent-data-session-id': sessionId };
      if (bridgeResponse) {
        delete outgoingHeaders['content-length'];
        delete outgoingHeaders['content-encoding'];
        delete outgoingHeaders.etag;
        outgoingHeaders['content-type'] = outgoingContentType;
      }
      clientResponse.writeHead(statusCode, outgoingHeaders);
      clientResponse.flushHeaders();
      void record('response_start', { status_code: statusCode, headers: upstreamResponse.headers, content_type: contentType });
      const parser = outgoingContentType.includes('text/event-stream') ? new (options.sseParser || SSEParser)() : null;
      const bridgeParser = bridgeResponse && contentType.includes('text/event-stream') ? new SSEParser() : null;
      const bridgeAdapter = bridgeResponse ? new ChatToResponses(bridgeState.request || {}, bridgeState.customTools) : null;
      let bridgeDone = false;
      let bridgeResponseBytes = 0;
      let captured = 0;
      let body = [];
      let decoder;
      const decodedData = (chunk) => {
        if (parser) {
          for (const event of parser.feed(chunk)) {
            stats.captured_events += 1;
            void record('sse_event', event);
          }
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
          for (const event of parser.finish()) {
            stats.captured_events += 1;
            void record('sse_event', event);
          }
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
      const emitLogicalChunk = (chunk) => {
        if (!clientClosed && !clientResponse.write(chunk)) upstreamResponse.pause();
        decodedData(chunk);
      };
      const bridgeSseEvent = (event) => {
        if (event.data === '[DONE]') {
          bridgeDone = true;
          return;
        }
        try {
          const payload = JSON.parse(event.data || '{}');
          for (const output of bridgeAdapter.consume(payload)) emitLogicalChunk(Buffer.from(encodeEvent(output)));
        } catch (error) {
          for (const output of bridgeAdapter.fail({ code: 'invalid_chat_json', message: error.message })) {
            emitLogicalChunk(Buffer.from(encodeEvent(output)));
          }
        }
      };
      const bridgeChunk = (chunk) => {
        if (bridgeStreaming) {
          for (const event of bridgeParser.feed(chunk)) bridgeSseEvent(event);
          return;
        }
        bridgeResponseBytes += chunk.length;
        if (bridgeResponseBytes <= maxCapture) bridgeState.response_body.push(Buffer.from(chunk));
        else recorder.incomplete = true;
      };
      const bridgeEnd = () => {
        if (!bridgeResponse) return;
        if (bridgeStreaming) {
          for (const event of bridgeParser.finish()) bridgeSseEvent(event);
          for (const output of bridgeAdapter.finish(bridgeDone)) emitLogicalChunk(Buffer.from(encodeEvent(output)));
          return;
        }
        const chatResponse = JSON.parse(Buffer.concat(bridgeState.response_body).toString('utf8'));
        const outputs = bridgeAdapter.consume(chatResponse).concat(bridgeAdapter.finish(true));
        if (bridgeState.request?.stream === false) {
          emitLogicalChunk(Buffer.from(JSON.stringify(bridgeAdapter.response())));
        } else {
          for (const output of outputs) emitLogicalChunk(Buffer.from(encodeEvent(output)));
        }
      };
      if (encoding === 'gzip') decoder = zlib.createGunzip();
      else if (encoding === 'deflate') decoder = zlib.createInflate();
      else if (encoding === 'br') decoder = zlib.createBrotliDecompress();
      else if (encoding && encoding !== 'identity') {
        recorder.incomplete = true;
        void record('capture_error', { code: 'unsupported_encoding', encoding });
      }
      if (decoder) {
        decoder.on('data', bridgeResponse ? bridgeChunk : decodedData);
        decoder.on('error', (error) => {
          recorder.incomplete = true;
          finish('capture_error', { message: error.message });
        });
      }
      upstreamResponse.on('data', (chunk) => {
        firstByteAt ||= new Date();
        if (decoder) decoder.write(chunk);
        else if (!encoding || encoding === 'identity') {
          if (bridgeResponse) bridgeChunk(chunk);
          else {
            if (!clientClosed && !clientResponse.write(chunk)) upstreamResponse.pause();
            decodedData(chunk);
          }
        }
      });
      clientResponse.on('drain', () => upstreamResponse.resume());
      const finishResponse = () => {
        try { bridgeEnd(); } catch (error) {
          recorder.incomplete = true;
          void record('capture_error', { code: 'bridge_error', message: error.message });
        }
        decodedEnd();
        responseEnded = true;
        stats.responses += 1;
        stats.last_activity = new Date().toISOString();
        if (!clientClosed) clientResponse.end();
      };
      upstreamResponse.on('end', () => {
        if (decoder) {
          decoder.once('end', finishResponse);
          decoder.end();
        } else finishResponse();
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
      if (!bridgeRequest && !upstreamRequest.destroyed && !upstreamRequest.write(chunk)) clientRequest.pause();
    });
    upstreamRequest.on('drain', () => clientRequest.resume());
    clientRequest.on('end', () => {
      const requestBody = requestBytes <= maxCapture
        ? requestBodyValue(Buffer.concat(requestChunks), String(clientRequest.headers['content-type'] || ''))
        : null;
      let upstreamBody;
      if (bridgeRequest && requestBody && typeof requestBody === 'object') {
        try {
          const converted = responsesToChat(requestBody);
          bridgeState.request = requestBody;
          bridgeState.customTools = converted.customTools;
          upstreamBody = Buffer.from(JSON.stringify(converted.chat));
        } catch (error) {
          void record('proxy_error', { code: error.code || 'bridge_request_error', message: error.message });
          finish('upstream_error', { code: error.code || 'bridge_request_error', message: error.message });
          if (!clientResponse.headersSent) {
            clientResponse.writeHead(error.statusCode || 400, { 'content-type': 'application/json', 'x-agent-data-session-id': sessionId });
            clientResponse.end(JSON.stringify({ error: { code: error.code || 'bridge_request_error', message: error.message } }));
          }
          return;
        }
      } else if (bridgeRequest) {
        const error = new Error('Responses-to-Chat bridge requires a JSON request body');
        error.code = 'bridge_request_body_required';
        void record('proxy_error', { code: error.code, message: error.message });
        finish('upstream_error', { code: error.code, message: error.message });
        if (!clientResponse.headersSent) {
          clientResponse.writeHead(400, { 'content-type': 'application/json', 'x-agent-data-session-id': sessionId });
          clientResponse.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
        }
        return;
      }
      void record('request', {
        method: clientRequest.method, url: clientRequest.url, headers: clientRequest.headers,
        body: requestBody,
        capture_incomplete: requestBytes > maxCapture, provider,
        ...(bridgeRequest ? { protocol_bridge: 'responses-to-chat' } : {})
      });
      const safety = inspectDangerousCommands(requestBody);
      if (safety.detected) {
        stats.safety_findings += safety.findings.length;
        for (const finding of safety.findings) void record('safety_finding', finding);
      }
      if (!upstreamRequest.destroyed) {
        if (bridgeRequest) upstreamRequest.end(upstreamBody);
        else upstreamRequest.end();
      }
    });
  });
  server.agentData = {
    upstream: options.upstream, dataDir, privacyMode, provider, protocol_bridge: protocolBridge, stats,
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

module.exports = {
  createProxyServer, listenProxy, makeTargetUrl, copyForwardHeaders,
  isModelsProbe, isResponsesToChatBridge, passthroughRequest, readSessionContext
};
