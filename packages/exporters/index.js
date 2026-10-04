const path = require('node:path');
const { redact } = require('@agent-data/redaction');
const { selectSessions } = require('@agent-data/filters');
const { listFilesRecursive, readJson, resolveDataDir, writeJson } = require('@agent-data/storage');
const fsp = require('node:fs').promises;

function assistantMessage(turn) {
  const content = String(turn.response?.text || '');
  const message = { role: 'assistant', content };
  if (turn.tool_calls?.length) {
    message.tool_calls = turn.tool_calls.map((call) => ({
      id: call.call_id || call.id || call.item_id,
      type: call.type || 'function',
      function: { name: call.name || '', arguments: call.arguments || call.arguments_delta || '' }
    }));
  }
  return message;
}

function sessionToMessages(session) {
  const turn = session.turns?.[0] || {};
  const messages = Array.isArray(turn.request?.messages) ? turn.request.messages.map((message) => ({ ...message })) : [];
  if (turn.response?.text || turn.tool_calls?.length) messages.push(assistantMessage(turn));
  for (const result of turn.tool_results || []) {
    messages.push({
      role: 'tool',
      tool_call_id: result.call_id || result.id,
      content: typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? result)
    });
  }
  return messages;
}

function toSftRecord(session, options = {}) {
  return redact({
    schema_version: 'sft-1',
    session_id: session.session_id,
    messages: sessionToMessages(session),
    metadata: {
      model: session.provider?.model || null,
      protocol: session.provider?.protocol || null,
      reward: session.reward || null,
      labels: session.labels || [],
      safety: session.safety || { risk_level: 'none', findings: [] },
      verification: session.verification || [],
      environment: options.include_environment === false ? undefined : session.environment || {}
    }
  }, { mode: options.privacyMode || 'safe' });
}

function toRlRecord(session, options = {}) {
  return redact({
    schema_version: 'rl-1',
    session_id: session.session_id,
    trajectory: session.events || [],
    reward: session.reward?.value ?? 0,
    reward_signals: session.reward?.signals || {},
    labels: session.labels || [],
    metadata: {
      model: session.provider?.model || null,
      protocol: session.provider?.protocol || null,
      verification: session.verification || [],
      labels: session.labels || [],
      safety: session.safety || { risk_level: 'none', findings: [] },
      environment: options.include_environment === false ? undefined : session.environment || {}
    }
  }, { mode: options.privacyMode || 'safe' });
}

async function loadSessions(dataDir, sessionId) {
  if (sessionId) return [await readJson(path.join(resolveDataDir(dataDir), 'sessions', `${sessionId}.json`))];
  const files = await listFilesRecursive(path.join(resolveDataDir(dataDir), 'sessions'), '.json');
  const sessions = [];
  for (const file of files) {
    try { sessions.push(await readJson(file)); } catch { /* skip a partially written session */ }
  }
  return sessions.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

async function exportDataset(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const sessions = await loadSessions(dataDir, options.sessionId);
  const selection = selectSessions(sessions, {
    include_errors: options.include_errors,
    include_failed: options.include_failed,
    include_trivial: options.include_trivial,
    min_response_chars: options.min_response_chars
  });
  const converter = options.type === 'rl' ? toRlRecord : toSftRecord;
  const records = selection.selected.map((session) => converter(session, options));
  const output = options.output
    ? path.resolve(options.output)
    : path.join(dataDir, 'datasets', `${options.type || 'sft'}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
  const manifest = {
    format: options.type === 'rl' ? 'rl-1' : 'sft-1',
    created_at: new Date().toISOString(),
    output,
    total_sessions: sessions.length,
    exported_sessions: records.length,
    skipped: selection.reports.filter((report) => !report.include),
    privacy_mode: options.privacyMode || 'safe'
  };
  await writeJson(`${output}.manifest.json`, manifest);
  return { ...manifest, records };
}

module.exports = { assistantMessage, sessionToMessages, toSftRecord, toRlRecord, loadSessions, exportDataset };
