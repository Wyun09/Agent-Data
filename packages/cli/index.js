const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { listenProxy } = require('@agent-data/proxy');
const { reprocessRaw } = require('@agent-data/recorder');
const { normalizeRawRecords } = require('@agent-data/protocol-openai');
const { captureEnvironment } = require('@agent-data/environment');
const { executeVerification, saveContext, saveVerification } = require('@agent-data/verification');
const { computeReward } = require('@agent-data/rewards');
const { selectSessions } = require('@agent-data/filters');
const { exportDataset, loadSessions } = require('@agent-data/exporters');
const {
  resolveDataDir,
  ensureDataDirs,
  listFilesRecursive,
  readJson,
  writeJson,
  sessionPath,
  appendRawRecord
} = require('@agent-data/storage');

const VERSION = '0.2.0';

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
      const separator = arg.indexOf('=');
      const key = arg.slice(2, separator < 0 ? undefined : separator);
      const inline = separator < 0 ? undefined : arg.slice(separator + 1);
      if (inline !== undefined) options[key.replaceAll('-', '_')] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith('-')) options[key.replaceAll('-', '_')] = argv[++index];
      else options[key.replaceAll('-', '_')] = true;
    } else positional.push(arg);
  }
  return { positional, options };
}

function printHelp() {
  process.stdout.write(`Agent Session Data Factory ${VERSION}\n\nUsage:\n  agent-data proxy --upstream <url> [options]\n  agent-data start --upstream <url> [options]\n  agent-data run [options] -- <agent command> [args...]\n  agent-data verify [options] -- <command> [args...]\n  agent-data sessions [--data-dir <dir>]\n  agent-data show <session-id> [--data-dir <dir>]\n  agent-data reprocess [--all|--session <id>] [--data-dir <dir>]\n  agent-data filter [--data-dir <dir>]\n  agent-data export sft|rl [options]\n  agent-data doctor [--data-dir <dir>]\n  agent-data config [--data-dir <dir>]\n  agent-data mock-upstream [--port <port>]\n  agent-data version\n\nProxy options:\n  --upstream URL       Upstream API origin (required)\n  --port PORT          Listen port (default 8787)\n  --host HOST          Listen host (default 127.0.0.1)\n  --data-dir DIR       Data directory (default ~/.agent-data)\n  --privacy-mode MODE  safe, strict, or off (default safe)\n  --provider NAME      Protocol adapter (default openai-responses)\n  --auto-export        continuously write aggregate SFT/RL datasets\n  --dashboard          show live request/session counters\n\nRun options:\n  --upstream URL       Upstream API origin (default https://api.openai.com/v1)\n  --auth-mode MODE     codex-login (default) or api-key\n  --session-id ID      Correlate all requests from the child process\n\nExport options:\n  --output FILE        JSONL destination (default data-dir/datasets)\n  --session ID         Export one session\n  --include-failed     Keep sessions with failed verification\n  --include-trivial    Keep short/no-tool trajectories\n`);
}

function enabledOption(value) {
  return value === true || value === '' || String(value).toLowerCase() === 'true';
}

async function autoExportSession(dataDir, privacyMode) {
  const outputDir = path.join(dataDir, 'datasets', 'auto');
  await exportDataset({
    dataDir,
    type: 'sft',
    output: path.join(outputDir, 'sft.jsonl'),
    include_errors: true,
    include_failed: true,
    include_trivial: true,
    privacyMode
  });
  await exportDataset({
    dataDir,
    type: 'rl',
    output: path.join(outputDir, 'rl.jsonl'),
    include_errors: true,
    include_failed: true,
    include_trivial: true,
    privacyMode
  });
}

async function commandProxy(options) {
  if (!options.upstream) throw new Error('--upstream is required for proxy');
  const host = options.host || '127.0.0.1';
  const dataDir = resolveDataDir(options.data_dir);
  const privacyMode = options.privacy_mode || 'safe';
  const autoExport = enabledOption(options.auto_export);
  let autoExportTail = Promise.resolve();
  const server = await listenProxy({
    upstream: options.upstream,
    port: options.port === undefined ? 8787 : Number(options.port),
    host,
    dataDir,
    defaultSessionId: options.default_session_id || (autoExport ? crypto.randomUUID() : undefined),
    privacyMode,
    provider: options.provider || 'openai-responses',
    normalizer: normalizeRawRecords,
    timeoutMs: options.timeout_ms ? Number(options.timeout_ms) : 0,
    onSessionFinalized: autoExport
      ? (finalized) => {
        autoExportTail = autoExportTail.then(() => autoExportSession(dataDir, privacyMode));
        return autoExportTail;
      }
      : undefined
  });
  const address = server.address();
  process.stdout.write(`agent-data proxy listening on http://${host}:${address.port}; upstream ${options.upstream}\n`);
  if (autoExport) process.stdout.write(`auto datasets: ${path.join(dataDir, 'datasets', 'auto')}\n`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    process.stderr.write('warning: proxy is listening on a non-loopback interface\n');
  }
  let dashboardTimer;
  if (enabledOption(options.dashboard)) {
    dashboardTimer = setInterval(() => {
      const stats = server.agentData.stats;
      process.stdout.write(`\r[agent-data] sessions=${stats.sessions} requests=${stats.requests} responses=${stats.responses} events=${stats.captured_events} last=${stats.last_activity || '-'}   `);
    }, 1000);
    dashboardTimer.unref?.();
  }
  await new Promise((resolve) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      if (dashboardTimer) clearInterval(dashboardTimer);
      server.close(async () => {
        await server.agentData.drain?.();
        if (dashboardTimer) process.stdout.write('\n');
        resolve();
      });
    };
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

function isCodexExecutable(command) {
  return /(^|[\\/])codex(?:\.js)?$/i.test(String(command || '')) || String(command || '').toLowerCase() === 'codex';
}

function codexProviderArgs(baseUrl, sessionId, authMode) {
  const provider = 'agent_data_proxy';
  const args = [
    '-c', 'model_provider="' + provider + '"',
    '-c', 'model_providers.' + provider + '.name="Agent Data Proxy"',
    '-c', 'model_providers.' + provider + '.base_url=' + JSON.stringify(baseUrl),
    '-c', 'model_providers.' + provider + '.wire_api="responses"',
    '-c', 'model_providers.' + provider + '.supports_websockets=false',
    '-c', 'model_providers.' + provider + '.http_headers={"x-agent-data-session-id"=' + JSON.stringify(sessionId) + '}'
  ];
  if (authMode === 'api-key') args.push('-c', 'model_providers.' + provider + '.env_key="OPENAI_API_KEY"');
  else args.push('-c', 'model_providers.' + provider + '.requires_openai_auth=true');
  return args;
}

function assertCodexAuth(authMode, executable) {
  if (authMode === 'api-key') {
    if (!process.env.OPENAI_API_KEY) throw new Error('auth-mode api-key requires OPENAI_API_KEY');
    return;
  }
  try {
    execFileSync(executable, ['login', 'status'], { stdio: 'ignore', timeout: 5000 });
  } catch {
    throw new Error('Codex is not logged in. Run codex login first.');
  }
}

function spawnAttached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'inherit', shell: false });
    const forward = (signal) => { if (!child.killed) child.kill(signal); };
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const cleanup = () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 1), signal }); });
  });
}

async function commandRun(options) {
  const command = options.command;
  if (!Array.isArray(command) || !command.length) throw new Error('run requires a command after --');
  const authMode = options.auth_mode || process.env.AGENT_DATA_AUTH_MODE || 'codex-login';
  if (!['codex-login', 'api-key'].includes(authMode)) throw new Error('--auth-mode must be codex-login or api-key');
  const isCodex = isCodexExecutable(command[0]);
  if (isCodex) assertCodexAuth(authMode, command[0]);
  const dataDir = await ensureDataDirs(options.data_dir);
  const sessionId = options.session_id || crypto.randomUUID();
  const cwd = path.resolve(options.cwd || process.cwd());
  const environment = captureEnvironment({ cwd, command });
  const context = await saveContext({
    dataDir, sessionId, environment,
    agent: { name: path.basename(command[0]), version: environment.agent?.version, executable: environment.agent?.executable },
    metadata: { launcher: 'agent-data run' }
  });
  const upstream = options.upstream || process.env.AGENT_DATA_UPSTREAM || 'https://api.openai.com/v1';
  const host = options.host || '127.0.0.1';
  const server = await listenProxy({
    upstream, host, dataDir, defaultSessionId: sessionId,
    port: options.port === undefined ? 0 : Number(options.port),
    privacyMode: options.privacy_mode || 'safe',
    normalizer: normalizeRawRecords
  });
  const baseUrl = 'http://' + host + ':' + server.address().port + '/v1';
  const childEnv = { ...process.env, AGENT_DATA_HOME: dataDir, AGENT_DATA_SESSION_ID: sessionId, AGENT_DATA_PROXY_URL: baseUrl };
  const childArgs = isCodex ? [...codexProviderArgs(baseUrl, sessionId, authMode), ...command.slice(1)] : command.slice(1);
  process.stderr.write('Session: ' + sessionId + '\nData: ' + dataDir + '\n');
  let result;
  try {
    result = await spawnAttached(command[0], childArgs, { cwd, env: childEnv });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (server.agentData.drain) await server.agentData.drain();
    await reprocessRaw({ dataDir, sessionId });
  }
  process.exitCode = result.code;
  return { session_id: sessionId, exit_code: result.code, signal: result.signal, context: context.file };
}

async function commandVerify(options) {
  if (!options.command?.length) throw new Error('verify requires a command after --');
  const dataDir = await ensureDataDirs(options.data_dir);
  const sessionId = options.session || process.env.AGENT_DATA_SESSION_ID;
  if (!sessionId) throw new Error('verify requires --session <id>; use the session id printed by run');
  const result = await executeVerification({
    command: options.command, cwd: options.cwd,
    timeoutMs: options.timeout_ms ? Number(options.timeout_ms) : 0,
    maxOutputBytes: options.max_output_bytes ? Number(options.max_output_bytes) : 16384,
    privacyMode: options.privacy_mode || 'safe'
  });
  const saved = await saveVerification({ dataDir, sessionId, result, privacyMode: options.privacy_mode });
  await reprocessRaw({ dataDir, sessionId });
  const session = await readJson(sessionPath(dataDir, sessionId));
  const reward = computeReward(session);
  await appendRawRecord(saved.rawFile, sessionId, 'reward_signal', reward);
  await reprocessRaw({ dataDir, sessionId });
  process.stdout.write(JSON.stringify({ session_id: sessionId, verification: result, reward }, null, 2) + '\n');
  process.exitCode = result.success ? 0 : (result.exit_code || 1);
  return result;
}

async function commandFilter(options) {
  const sessions = await loadSessions(options.data_dir);
  const selection = selectSessions(sessions, options);
  process.stdout.write(JSON.stringify({ total: sessions.length, selected: selection.selected.length, reports: selection.reports }, null, 2) + '\n');
  return selection;
}

async function commandExport(kind, options) {
  if (!['sft', 'rl'].includes(kind)) throw new Error('export format must be sft or rl');
  const result = await exportDataset({ ...options, type: kind, dataDir: options.data_dir, sessionId: options.session, privacyMode: options.privacy_mode });
  const { records, ...manifest } = result;
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  return result;
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
    case 'start': return commandProxy({ ...options, auto_export: true, dashboard: true });
    case 'run': return commandRun(options);
    case 'verify': return commandVerify(options);
    case 'filter': return commandFilter(options);
    case 'export': return commandExport(positional[1], options);
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

module.exports = { main, parseArgs, commandMockUpstream, commandRun, commandVerify, codexProviderArgs, isCodexExecutable };
