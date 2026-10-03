const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { listenProxy } = require('@agent-data/proxy');
const { reprocessRaw } = require('@agent-data/recorder');
const { normalizeRawRecords } = require('@agent-data/protocol-openai');
const {
  resolveDataDir,
  ensureDataDirs,
  listFilesRecursive,
  readJson,
  writeJson,
  sessionPath
} = require('@agent-data/storage');

const VERSION = '0.1.0';

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options.command = argv.slice(index + 1);
      break;
    }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) options[key.replaceAll('-', '_')] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith('-')) options[key.replaceAll('-', '_')] = argv[++index];
      else options[key.replaceAll('-', '_')] = true;
    } else positional.push(arg);
  }
  return { positional, options };
}

function printHelp() {
  process.stdout.write(`Agent Session Data Factory ${VERSION}\n\nUsage:\n  agent-data proxy --upstream <url> [options]\n  agent-data sessions [--data-dir <dir>]\n  agent-data show <session-id> [--data-dir <dir>]\n  agent-data reprocess [--all|--session <id>] [--data-dir <dir>]\n  agent-data doctor [--data-dir <dir>]\n  agent-data config [--data-dir <dir>]\n  agent-data mock-upstream [--port <port>]\n  agent-data version\n\nProxy options:\n  --upstream URL       Upstream API origin (required)\n  --port PORT          Listen port (default 8787)\n  --host HOST          Listen host (default 127.0.0.1)\n  --data-dir DIR       Data directory (default ~/.agent-data)\n  --privacy-mode MODE  safe, strict, or off (default safe)\n  --provider NAME      Protocol adapter (default openai-responses)\n`);
}

async function commandProxy(options) {
  if (!options.upstream) throw new Error('--upstream is required for proxy');
  const host = options.host || '127.0.0.1';
  const server = await listenProxy({
    upstream: options.upstream,
    port: options.port === undefined ? 8787 : Number(options.port),
    host,
    dataDir: options.data_dir,
    privacyMode: options.privacy_mode || 'safe',
    provider: options.provider || 'openai-responses',
    normalizer: normalizeRawRecords,
    timeoutMs: options.timeout_ms ? Number(options.timeout_ms) : 0
  });
  const address = server.address();
  process.stdout.write(`agent-data proxy listening on http://${host}:${address.port}; upstream ${options.upstream}\n`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    process.stderr.write('warning: proxy is listening on a non-loopback interface\n');
  }
  await new Promise((resolve) => {
    const close = () => server.close(() => resolve());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

async function commandSessions(options) {
  const dataDir = resolveDataDir(options.data_dir);
  const files = await listFilesRecursive(path.join(dataDir, 'sessions'), '.json');
  const rows = [];
  for (const file of files) {
    try {
      const session = await readJson(file);
      rows.push({ session_id: session.session_id, started_at: session.started_at, ended_at: session.ended_at, provider: session.provider?.protocol, turns: session.turns?.length || 0 });
    } catch (error) {
      rows.push({ file, error: error.message });
    }
  }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

async function commandShow(sessionId, options) {
  if (!sessionId) throw new Error('session id is required');
  const session = await readJson(sessionPath(resolveDataDir(options.data_dir), sessionId));
  process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
}

async function commandReprocess(options) {
  const results = await reprocessRaw({ dataDir: options.data_dir, sessionId: options.session });
  process.stdout.write(`${JSON.stringify(results.map((item) => ({ session_id: item.session.session_id, destination: item.destination })), null, 2)}\n`);
}

async function commandDoctor(options) {
  const dataDir = await ensureDataDirs(options.data_dir);
  const report = {
    version: VERSION,
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    data_dir: dataDir,
    data_dir_writable: true,
    loopback_default: true
  };
  const probe = path.join(dataDir, `.doctor-${process.pid}`);
  try {
    await fsp.writeFile(probe, 'ok\n', { mode: 0o600 });
    await fsp.unlink(probe);
  } catch (error) {
    report.data_dir_writable = false;
    report.data_dir_error = error.message;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.data_dir_writable) process.exitCode = 1;
}

async function commandConfig(options) {
  const dataDir = resolveDataDir(options.data_dir);
  const file = path.join(dataDir, 'config.json');
  let config;
  try { config = await readJson(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { proxy: {}, storage: { data_dir: dataDir }, privacy: { mode: 'safe' }, filters: {}, rewards: {}, export: {} };
    await writeJson(file, config);
  }
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

async function commandMockUpstream(options) {
  const port = options.port === undefined ? 9876 : Number(options.port);
  const server = http.createServer((request, response) => {
    if (!request.url?.startsWith('/v1/responses')) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
    const events = [
      ['response.created', { type: 'response.created', sequence_number: 0, response: { id: 'mock-response', status: 'in_progress', model: 'mock-model', output: [] } }],
      ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, response_id: 'mock-response', output_index: 0, item: { id: 'msg-1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } }],
      ['response.content_part.added', { type: 'response.content_part.added', sequence_number: 2, response_id: 'mock-response', item_id: 'msg-1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 3, response_id: 'mock-response', item_id: 'msg-1', output_index: 0, content_index: 0, delta: 'mock ' }],
      ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 4, response_id: 'mock-response', item_id: 'msg-1', output_index: 0, content_index: 0, delta: 'stream' }],
      ['response.output_text.done', { type: 'response.output_text.done', sequence_number: 5, response_id: 'mock-response', item_id: 'msg-1', output_index: 0, content_index: 0, text: 'mock stream' }],
      ['response.content_part.done', { type: 'response.content_part.done', sequence_number: 6, response_id: 'mock-response', item_id: 'msg-1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'mock stream', annotations: [] } }],
      ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 7, response_id: 'mock-response', output_index: 0, item: { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'mock stream', annotations: [] }] } }],
      ['response.completed', { type: 'response.completed', sequence_number: 8, response: { id: 'mock-response', status: 'completed', output: [{ id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'mock stream', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }]
    ];
    let index = 0;
    const timer = setInterval(() => {
      if (index >= events.length) {
        clearInterval(timer);
        response.end();
        return;
      }
      const [event, payload] = events[index++];
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }, 10);
    request.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stdout.write(`mock upstream listening on http://127.0.0.1:${server.address().port}\n`);
  await new Promise((resolve) => {
    const close = () => server.close(() => resolve());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0] || 'help';
  switch (command) {
    case 'proxy': return commandProxy(options);
    case 'sessions': return commandSessions(options);
    case 'show': return commandShow(positional[1], options);
    case 'reprocess': return commandReprocess(options);
    case 'doctor': return commandDoctor(options);
    case 'config': return commandConfig(options);
    case 'mock-upstream': return commandMockUpstream(options);
    case 'version': return process.stdout.write(`${VERSION}\n`);
    case 'help':
    case '--help':
    case '-h': return printHelp();
    default:
      printHelp();
      throw new Error(`unknown command: ${command}`);
  }
}

module.exports = { main, parseArgs, commandMockUpstream };
