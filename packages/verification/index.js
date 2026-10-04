const crypto = require('node:crypto');
const path = require('node:path');
const { captureEnvironment, runCommand } = require('@agent-data/environment');
const { redactString } = require('@agent-data/redaction');
const {
  appendRawRecord,
  contextPath,
  ensureDataDirs,
  findRawFile,
  rawPath,
  resolveDataDir,
  verificationPath,
  writeJson
} = require('@agent-data/storage');

function trimOutput(value, maxBytes = 16 * 1024, mode = 'safe') {
  const text = redactString(String(value || ''), { mode });
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return `…${buffer.subarray(buffer.length - maxBytes).toString('utf8')}`;
}

function verificationId() {
  return `verify-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function classifyCommand(command) {
  const text = command.join(' ').toLowerCase();
  if (/\b(test|pytest|vitest|jest|unittest|check)\b/.test(text)) return 'tests';
  if (/\b(build|compile|typecheck|lint)\b/.test(text)) return 'build';
  return 'command';
}

async function executeVerification(options = {}) {
  const command = options.command;
  if (!Array.isArray(command) || !command.length) throw new TypeError('command must contain an executable');
  const result = runCommand(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes
  });
  const mode = options.privacyMode || 'safe';
  return {
    verification_id: options.verificationId || verificationId(),
    kind: options.kind || classifyCommand(command),
    command: result.command,
    cwd: result.cwd,
    started_at: result.started_at,
    ended_at: result.ended_at,
    duration_ms: result.duration_ms,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    success: result.success,
    stdout_tail: trimOutput(result.stdout, options.maxOutputBytes || 16 * 1024, mode),
    stderr_tail: trimOutput(result.stderr, options.maxOutputBytes || 16 * 1024, mode),
    error: result.error,
    environment: result.environment
  };
}

async function saveContext(options = {}) {
  const dataDir = await ensureDataDirs(options.dataDir);
  const sessionId = options.sessionId || crypto.randomUUID();
  const context = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    agent: options.agent || null,
    environment: options.environment || captureEnvironment({ cwd: options.cwd, command: options.command }),
    metadata: options.metadata || {}
  };
  const file = contextPath(dataDir, sessionId);
  await writeJson(file, context);
  return { context, file, dataDir };
}

async function saveVerification(options = {}) {
  const dataDir = await ensureDataDirs(options.dataDir);
  const sessionId = options.sessionId || options.result?.session_id || crypto.randomUUID();
  const result = { ...(options.result || {}), session_id: sessionId };
  const file = await findRawFile(dataDir, sessionId);
  if (file) {
    await appendRawRecord(file, sessionId, 'verification_result', result, { privacyMode: options.privacyMode });
  } else {
    const target = rawPath(dataDir, sessionId, result.started_at);
    await appendRawRecord(target, sessionId, 'session_start', {
      session_id: sessionId,
      provider: { protocol: 'verification' },
      environment: result.environment,
      agent: result.environment?.agent || null
    }, { privacyMode: options.privacyMode, timestamp: result.started_at });
    await appendRawRecord(target, sessionId, 'verification_result', result, { privacyMode: options.privacyMode });
    await appendRawRecord(target, sessionId, 'session_end', { verification_only: true }, { privacyMode: options.privacyMode, timestamp: result.ended_at });
  }
  const destination = verificationPath(dataDir, result.verification_id);
  await writeJson(destination, result);
  return { sessionId, rawFile: file || rawPath(dataDir, sessionId, result.started_at), destination, result };
}

module.exports = {
  classifyCommand,
  executeVerification,
  saveContext,
  saveVerification,
  trimOutput,
  verificationId
};
