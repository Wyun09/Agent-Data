const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { listFilesRecursive, readJsonl } = require('@agent-data/storage');
const { redact } = require('@agent-data/redaction');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const indexTails = new Map();

function resolveCodexHome(input) {
  return path.resolve(input || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

function firstUserText(session) {
  for (const turn of session?.turns || []) {
    for (const message of turn.request?.messages || []) {
      if (message?.role !== 'user') continue;
      const content = typeof message.content === 'string' ? message.content :
        Array.isArray(message.content) ? message.content.map((part) => part?.text || '').join(' ') : '';
      if (content.trim()) return content.trim();
    }
  }
  return '';
}

function threadName(session, maxLength = 120) {
  const value = session?.metadata?.thread_name || firstUserText(session) || session?.agent?.name || 'Agent session';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength) || 'Agent session';
}

function sessionIndexEntry(session, options = {}) {
  const updatedAt = session?.ended_at || session?.started_at || new Date().toISOString();
  return {
    id: String(options.threadId || session.metadata?.codex?.thread_id || session.session_id),
    thread_name: threadName(session, options.maxThreadNameLength),
    updated_at: updatedAt
  };
}

async function appendSessionIndex(session, options = {}) {
  if (!session?.session_id) throw new TypeError('session.session_id is required');
  const codexHome = resolveCodexHome(options.codexHome);
  const file = path.resolve(options.indexPath || path.join(codexHome, 'session_index.jsonl'));
  const candidate = sessionIndexEntry(session, options);
  const rollout = await findCodexRollout(candidate.id, { ...options, codexHome });
  if (!rollout) return { file, synced: false, reason: 'native_rollout_missing', thread_id: candidate.id };
  const task = (indexTails.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    let latest;
    try {
      for (const line of (await fsp.readFile(file, 'utf8')).split(/\r?\n/)) {
        try { const entry = JSON.parse(line); if (entry.id === candidate.id) latest = entry; } catch { /* preserve unrecognized lines */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entry = redact({
      ...candidate,
      thread_name: latest?.thread_name || candidate.thread_name,
      updated_at: latest?.updated_at > candidate.updated_at ? latest.updated_at : candidate.updated_at
    }, { mode: options.privacyMode || 'safe' });
    if (latest?.thread_name === entry.thread_name && latest?.updated_at === entry.updated_at) {
      return { file, entry, rollout, synced: true, appended: false };
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Codex owns this append-only file. Append one complete line; never rewrite it.
    let separator = '';
    try {
      const handle = await fsp.open(file, 'r');
      try {
        const stat = await handle.stat();
        if (stat.size) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, stat.size - 1); if (last[0] !== 10) separator = '\n'; }
      } finally { await handle.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fsp.appendFile(file, separator + JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    return { file, entry, rollout, synced: true, appended: true };
  });
  indexTails.set(file, task);
  try { return await task; } finally { if (indexTails.get(file) === task) indexTails.delete(file); }
}

async function findCodexRollout(threadId, options = {}) {
  if (!UUID.test(String(threadId))) return null;
  const home = resolveCodexHome(options.codexHome);
  const candidates = options.rolloutPath ? [path.resolve(options.rolloutPath)] :
    (await listFilesRecursive(path.join(home, 'sessions'), '.jsonl')).filter((file) => file.endsWith('-' + threadId + '.jsonl'));
  for (const file of candidates) {
    const relative = path.relative(path.join(home, 'sessions'), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      const firstLine = (await fsp.readFile(file, 'utf8')).split('\n').find((line) => line.trim());
      const meta = JSON.parse(firstLine);
      if (meta.type === 'session_meta' && (meta.payload?.id === threadId || meta.payload?.session_id === threadId)) return file;
    } catch { /* incomplete or unrelated rollout is not a resumable thread */ }
  }
  return null;
}

async function syncSessionToCodex(session, options = {}) {
  const ids = new Set();
  if (session.metadata?.codex?.thread_id) ids.add(session.metadata.codex.thread_id);
  if (options.rawFile) {
    for (const record of await readJsonl(options.rawFile)) {
      const headers = record.kind === 'request' ? record.payload?.headers : null;
      const id = headers?.['thread-id'] || headers?.['session-id'] || headers?.['x-codex-thread-id'];
      if (UUID.test(String(id))) ids.add(id);
    }
  }
  if (!ids.size && UUID.test(session.session_id)) ids.add(session.session_id);
  const results = [];
  for (const id of ids) results.push(await appendSessionIndex(session, { ...options, threadId: id }));
  return { session_id: session.session_id, results };
}

async function resolveResumeThread(session, options = {}) {
  const result = await syncSessionToCodex(session, options);
  const native = result.results.find((item) => item.synced);
  if (!native) throw new Error('No native Codex rollout for this session. Export a Codex rollout first; an index ID alone cannot be resumed.');
  return { thread_id: native.entry.id, rollout: native.rollout };
}

module.exports = {
  resolveCodexHome, firstUserText, threadName, sessionIndexEntry,
  appendSessionIndex, findCodexRollout, syncSessionToCodex, resolveResumeThread
};
