const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const { SSEParser: GenericSSEParser } = require('@agent-data/core/sse');
const { RawEventRecorder } = require('@agent-data/recorder');
const { finalizeRawSession } = require('@agent-data/recorder');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function copyForwardHeaders(headers, target) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length' || lower === 'x-agent-data-session-id') continue;
    result[name] = value;
  }
  result.host = target.host;
  return result;
}

function requestBodyValue(buffer, contentType) {
  const text = buffer.toString('utf8');
  if (contentType && contentType.includes('json')) {
    try { return JSON.parse(text); } catch { /* preserve text below */ }
  }
  return text;
}

function makeTargetUrl(upstream, incomingUrl) {
  const base = new URL(upstream);
  const requestUrl = new URL(incomingUrl || '/', 'http://agent-data.invalid');
  const basePath = base.pathname.replace(/\/$/, '');
  const requestPath = requestUrl.pathname;
  if (!basePath || basePath === '/') base.pathname = requestPath;
  else if (requestPath === basePath || requestPath.startsWith(`${basePath}/`)) base.pathname = requestPath;
  else base.pathname = `${basePath}/${requestPath.replace(/^\/+/, '')}`;
  base.search = requestUrl.search;
  return base;
}

function responseHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) output[name] = value;
  }
  return output;
}

function createProxyServer(options = {}) {
  if (!options.upstream) throw new TypeError('upstream is required');
  const upstream = new URL(options.upstream);
  const protocol = upstream.protocol === 'https:' ? https : http;
  const dataDir = options.dataDir;
  const privacyMode = options.privacyMode || 'safe';
  const provider = options.provider || 'openai-responses';

  const server = http.createServer((clientRequest, clientResponse) => {
    const sessionId = String(clientRequest.headers['x-agent-data-session-id'] || crypto.randomUUID());
    const startedAt = new Date();
    const recorder = new RawEventRecorder({ sessionId, dataDir, privacyMode, startedAt: startedAt.toISOString(), maxQueue: options.maxRecorderQueue, maxQueueBytes: options.maxRecorderQueueBytes });
    const requestChunks = [];
    let requestEnded = false;
    let responseStarted = false;
    let responseEnded = false;
    let clientClosed = false;
    let upstreamRequest;
    let upstreamResponse;
    let responseParser;
    let firstTokenAt;
    let responseContentType = '';
    let finalized = false;

    clientResponse.setHeader('x-agent-data-session-id', sessionId);
    void recorder.record('session_start', {
      session_id: sessionId,
      method: clientRequest.method,
      url: clientRequest.url,
      provider,
      client: { user_agent: clientRequest.headers['user-agent'] || null }
    }, { timestamp: startedAt.toISOString() });

    const finish = async (kind, payload = {}) => {
      if (finalized) return;
      finalized = true;
      await recorder.record(kind, payload);
      await recorder.record('session_end', {
        ended: true,
        recording_incomplete: recorder.incomplete,
        provider
      });
      await recorder.flush();
      try {
        await finalizeRawSession({ dataDir, file: recorder.file, sessionId, privacyMode, normalizer: options.normalizer });
      } catch (error) {
        process.emitWarning(`agent-data canonicalization: ${error.message}`);
      }
    };

    const abortUpstream = () => {
      if (upstreamRequest && !upstreamRequest.destroyed) upstreamRequest.destroy();
    };

    clientRequest.on('aborted', () => {
      clientClosed = true;
      abortUpstream();
      void finish('client_disconnect', { phase: 'request', message: 'client aborted request' });
    });
    clientResponse.on('close', () => {
      if (!responseEnded && !clientResponse.writableEnded) {
        clientClosed = true;
        abortUpstream();
        void finish('client_disconnect', { phase: 'response', message: 'client closed response' });
      }
    });

    let target;
    try {
      target = makeTargetUrl(options.upstream, clientRequest.url);
    } catch (error) {
      void recorder.record('proxy_error', { code: 'invalid_target', message: error.message });
      clientResponse.statusCode = 500;
      clientResponse.end('invalid upstream target');
      void finish('proxy_error', { code: 'invalid_target', message: error.message });
      return;
    }

    const requestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: clientRequest.method,
      path: `${target.pathname}${target.search}`,
      headers: copyForwardHeaders(clientRequest.headers, target),
      timeout: options.timeoutMs || 0,
      rejectUnauthorized: options.rejectUnauthorized
    };

    upstreamRequest = protocol.request(requestOptions, (upstreamRes) => {
      upstreamResponse = upstreamRes;
      responseStarted = true;
      responseContentType = String(upstreamRes.headers['content-type'] || '');
      const responseStartAt = new Date();
      clientResponse.statusCode = upstreamRes.statusCode || 502;
      for (const [name, value] of Object.entries(responseHeaders(upstreamRes.headers))) {
        try { clientResponse.setHeader(name, value); } catch { /* invalid upstream header */ }
      }
      clientResponse.setHeader('x-agent-data-session-id', sessionId);
      clientResponse.flushHeaders?.();
      void recorder.record('response_start', {
        status_code: upstreamRes.statusCode,
        headers: upstreamRes.headers,
        content_type: responseContentType
      }, { timestamp: responseStartAt.toISOString() });

      if (responseContentType.toLowerCase().includes('text/event-stream')) {
        const Parser = options.sseParser || GenericSSEParser;
        responseParser = new Parser();
      }
      upstreamRes.on('data', (chunk) => {
        if (!firstTokenAt) firstTokenAt = new Date();
        if (!clientResponse.writableEnded && !clientClosed) clientResponse.write(chunk);
        if (responseParser) {
          const events = responseParser.feed(chunk);
          for (const event of events) void recorder.record('sse_event', event);
        } else {
          void recorder.record('response_chunk', { encoding: 'base64', data: Buffer.from(chunk).toString('base64') });
        }
      });
      upstreamRes.on('end', () => {
        if (responseParser) {
          for (const event of responseParser.finish()) void recorder.record('sse_event', event);
        }
        responseEnded = true;
        if (!clientResponse.writableEnded) clientResponse.end();
        const endedAt = new Date();
        void finish('response_end', {
          status_code: upstreamRes.statusCode,
          latency_ms: endedAt - startedAt,
          time_to_first_token_ms: firstTokenAt ? firstTokenAt - startedAt : null,
          content_type: responseContentType,
          provider
        });
      });
      upstreamRes.on('aborted', () => {
        void finish('upstream_error', { code: 'upstream_response_aborted', status_code: upstreamRes.statusCode });
        if (!clientResponse.writableEnded) clientResponse.end();
      });
      upstreamRes.on('error', (error) => {
        void finish('upstream_error', { code: error.code || 'upstream_response_error', message: error.message });
        if (!clientResponse.writableEnded) clientResponse.end();
      });
    });

    if (requestOptions.timeout) {
      upstreamRequest.setTimeout(requestOptions.timeout, () => {
        upstreamRequest.destroy(new Error('upstream timeout'));
      });
    }
    upstreamRequest.on('error', (error) => {
      void recorder.record('upstream_error', { code: error.code || 'upstream_error', message: error.message });
      if (!clientResponse.headersSent) {
        clientResponse.statusCode = error.code === 'ECONNRESET' ? 502 : 502;
        clientResponse.setHeader('content-type', 'application/json');
        clientResponse.end(JSON.stringify({ error: 'upstream_error', message: error.message }));
      } else if (!clientResponse.writableEnded) {
        clientResponse.end();
      }
      if (!responseEnded) {
        responseEnded = true;
        void finish('upstream_error', { code: error.code || 'upstream_error', message: error.message });
      }
    });

    clientRequest.on('data', (chunk) => {
      requestChunks.push(Buffer.from(chunk));
      upstreamRequest.write(chunk);
    });
    clientRequest.on('end', () => {
      requestEnded = true;
      const requestBuffer = Buffer.concat(requestChunks);
      void recorder.record('request', {
        method: clientRequest.method,
        url: clientRequest.url,
        headers: clientRequest.headers,
        body_text: requestBuffer.toString('utf8'),
        body: requestBodyValue(requestBuffer, clientRequest.headers['content-type']),
        provider
      });
      upstreamRequest.end();
    });
    clientRequest.on('error', (error) => {
      void recorder.record('proxy_error', { phase: 'client_request', code: error.code, message: error.message });
      abortUpstream();
    });
  });

  server.on('close', () => {
    // Requests own their recorder lifecycle. This hook exists for embedders to observe closure.
  });
  server.agentData = { upstream: options.upstream, dataDir, privacyMode, provider };
  return server;
}

async function listenProxy(options = {}) {
  const server = createProxyServer(options);
  const host = options.host || '127.0.0.1';
  const port = options.port === undefined ? 8787 : Number(options.port);
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  return server;
}

module.exports = { createProxyServer, listenProxy, makeTargetUrl, copyForwardHeaders };
