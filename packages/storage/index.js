const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { redact } = require('@agent-data/redaction');

function assertId(value, name = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${name} must be 1-128 letters, digits, dots, underscores, or hyphens`);
  }
  return value;
}

function resolveDataDir(input) {
  return path.resolve(input || process.env.AGENT_DATA_HOME || path.join(os.homedir(), '.agent-data'));
}

function datePart(timestamp = new Date().toISOString()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function rawPath(dataDir, sessionId, timestamp) {
  return path.join(resolveDataDir(dataDir), 'raw', datePart(timestamp), `${assertId(sessionId, 'session id')}.jsonl`);
}

function sessionPath(dataDir, sessionId) {
  return path.join(resolveDataDir(dataDir), 'sessions', `${assertId(sessionId, 'session id')}.json`);
}

async function ensureDataDirs(dataDir) {
  const root = resolveDataDir(dataDir);
  await Promise.all([
    fsp.mkdir(path.join(root, 'raw'), { recursive: true }),
    fsp.mkdir(path.join(root, 'sessions'), { recursive: true }),
    fsp.mkdir(path.join(root, 'contexts'), { recursive: true }),
    fsp.mkdir(path.join(root, 'verification'), { recursive: true }),
    fsp.mkdir(path.join(root, 'datasets'), { recursive: true }),
    fsp.mkdir(path.join(root, 'logs'), { recursive: true }),
    fsp.mkdir(path.join(root, 'cache'), { recursive: true })
  ]);
  return root;
}

function contextPath(dataDir, sessionId) {
  return path.join(resolveDataDir(dataDir), 'contexts', `${assertId(sessionId, 'session id')}.json`);
}

function verificationPath(dataDir, verificationId) {
  return path.join(resolveDataDir(dataDir), 'verification', `${assertId(verificationId, 'verification id')}.json`);
}

async function appendRawRecord(file, sessionId, kind, payload = {}, options = {}) {
  const record = {
    raw_schema_version: '1.0',
    event_id: options.event_id || require('node:crypto').randomUUID(),
    session_id: sessionId,
    recorded_at: options.timestamp || new Date().toISOString(),
    kind,
    payload: redact(payload, { mode: options.privacyMode || 'safe' })
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

async function findRawFile(dataDir, sessionId) {
  const files = await listFilesRecursive(path.join(resolveDataDir(dataDir), 'raw'), '.jsonl');
  for (const file of files) {
    try {
      const records = await readJsonl(file);
      if (records.some((record) => record.session_id === sessionId)) return file;
    } catch {
      // A malformed raw file is handled by reprocess and should not hide other sessions.
    }
  }
  return null;
}

async function writeJson(file, value, options = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const contents = JSON.stringify(redact(value, { mode: options.privacyMode || 'safe' }), null, 2) + '\n';
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fsp.writeFile(temporary, contents, { encoding: 'utf8', mode: options.mode || 0o600 });
  await fsp.rename(temporary, file);
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function readJsonl(file) {
  const text = await fsp.readFile(file, 'utf8');
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      const parseError = new Error(`Invalid JSONL at ${file}:${index + 1}: ${error.message}`);
      parseError.code = 'ERR_INVALID_JSONL';
      throw parseError;
    }
  }
  return records;
}

async function listFilesRecursive(dir, suffix) {
  const result = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await listFilesRecursive(file, suffix));
    else if (!suffix || entry.name.endsWith(suffix)) result.push(file);
  }
  return result.sort();
}

class RawEventRecorder {
  constructor(options = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.sessionId = options.sessionId;
    if (!this.sessionId) throw new TypeError('sessionId is required');
    this.privacyMode = options.privacyMode || 'safe';
    this.startedAt = options.startedAt || new Date().toISOString();
    this.file = rawPath(this.dataDir, this.sessionId, this.startedAt);
    this.maxQueue = options.maxQueue || 2048;
    this.maxQueueBytes = options.maxQueueBytes || 8 * 1024 * 1024;
    this.queueDepth = 0;
    this.queueBytes = 0;
    this.incomplete = false;
    this.error = null;
    this.tail = Promise.resolve();
    this.ready = ensureDataDirs(this.dataDir).then(() => fsp.mkdir(path.dirname(this.file), { recursive: true }));
  }

  record(kind, payload = {}, options = {}) {
    const lineBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (this.queueDepth >= this.maxQueue || this.queueBytes + lineBytes > this.maxQueueBytes) {
      this.incomplete = true;
      this.error = new Error('raw recorder queue overflow');
      return Promise.resolve(false);
    }
    const record = {
      raw_schema_version: '1.0',
      event_id: options.event_id || require('node:crypto').randomUUID(),
      session_id: this.sessionId,
      recorded_at: options.timestamp || new Date().toISOString(),
      kind,
      ...(options.requestId ? { request_id: options.requestId } : {}),
      ...(options.turnId ? { turn_id: options.turnId } : {}),
      payload: redact(payload, { mode: this.privacyMode })
    };
    const line = JSON.stringify(record) + '\n';
    this.queueDepth += 1;
    this.queueBytes += lineBytes;
    this.tail = this.tail
      .then(async () => {
        await this.ready;
        await fsp.appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
      })
      .catch((error) => {
        this.incomplete = true;
        this.error = error;
        process.emitWarning(`agent-data recorder: ${error.message}`);
      })
      .finally(() => {
        this.queueDepth -= 1;
        this.queueBytes = Math.max(0, this.queueBytes - lineBytes);
      });
    return this.tail.then(() => !this.incomplete);
  }

  async flush() {
    await this.tail;
    return { file: this.file, incomplete: this.incomplete, error: this.error };
  }
}

module.exports = {
  assertId,
  resolveDataDir,
  datePart,
  rawPath,
  sessionPath,
  contextPath,
  verificationPath,
  ensureDataDirs,
  writeJson,
  readJson,
  readJsonl,
  listFilesRecursive,
  appendRawRecord,
  findRawFile,
  RawEventRecorder
};
