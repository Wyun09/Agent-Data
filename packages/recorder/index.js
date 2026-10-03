const path = require('node:path');
const {
  RawEventRecorder,
  readJsonl,
  writeJson,
  sessionPath,
  listFilesRecursive,
  resolveDataDir
} = require('@agent-data/storage');
const { normalizeRawRecords: openaiNormalizer } = require('@agent-data/protocol-openai');
const { validateSession } = require('@agent-data/core');

async function finalizeRawSession(options = {}) {
  const file = options.file;
  if (!file) throw new TypeError('file is required');
  const records = await readJsonl(file);
  const normalizer = options.normalizer || openaiNormalizer;
  const session = normalizer(records, {
    sessionId: options.sessionId || records.find((item) => item.session_id)?.session_id,
    privacyMode: options.privacyMode
  });
  const validation = validateSession(session);
  if (!validation.valid) {
    const error = new Error(`canonical session validation failed: ${validation.errors.join('; ')}`);
    error.validation = validation;
    throw error;
  }
  const dataDir = resolveDataDir(options.dataDir || path.resolve(file, '../../..'));
  const destination = sessionPath(dataDir, session.session_id);
  await writeJson(destination, session);
  return { session, file, destination };
}

async function reprocessRaw(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const rawRoot = path.join(dataDir, 'raw');
  const files = options.file
    ? [options.file]
    : await listFilesRecursive(rawRoot, '.jsonl');
  const results = [];
  for (const file of files) {
    const records = await readJsonl(file);
    const sessionId = records.find((item) => item.session_id)?.session_id;
    if (options.sessionId && sessionId !== options.sessionId) continue;
    results.push(await finalizeRawSession({ ...options, dataDir, file, sessionId }));
  }
  return results;
}

module.exports = { RawEventRecorder, finalizeRawSession, reprocessRaw };
