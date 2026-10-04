const crypto = require('node:crypto');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { createSession, createCanonicalEvent, applyCanonicalEvent, validateSession } = require('@agent-data/core');

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part?.text || part?.input_text || '').join('');
}

function parseRollout(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`Invalid Codex rollout JSONL at line ${index + 1}: ${error.message}`); }
  });
}

function rolloutToSession(input, options = {}) {
  const records = Array.isArray(input) ? input : parseRollout(input);
  const meta = records.find((record) => record.type === 'session_meta')?.payload || {};
  const sessionId = options.sessionId || meta.id || meta.session_id || crypto.randomUUID();
  const session = createSession({
    sessionId,
    startedAt: meta.timestamp || records[0]?.timestamp,
    agent: { name: 'codex', version: meta.cli_version || null },
    provider: { protocol: 'codex-rollout', model: meta.model || null, model_provider: meta.model_provider || null },
    environment: { cwd: meta.cwd || null, runtime_workspace_roots: meta.runtime_workspace_roots || [] },
    metadata: { source: 'codex-rollout', originator: meta.originator || null, rollout_records: records.length }
  });
  let currentTurn = null;
  const apply = (type, data, record, turnId = currentTurn) => {
    const event = createCanonicalEvent(type, { ...data, ...(turnId ? { turn_id: turnId } : {}) }, record.timestamp);
    applyCanonicalEvent(session, event);
  };
  for (const record of records) {
    const payload = record.payload || {};
    if (record.type === 'session_meta') {
      apply('session_start', {
        agent: { name: 'codex', version: payload.cli_version || null },
        provider: { protocol: 'codex-rollout', model_provider: payload.model_provider || null },
        environment: { cwd: payload.cwd || null }
      }, record);
      continue;
    }
    if (record.type === 'event_msg') {
      if (payload.type === 'task_started') {
        currentTurn = payload.turn_id || currentTurn || crypto.randomUUID();
        apply('request_start', {}, record, currentTurn);
      } else if (payload.type === 'task_complete') {
        apply(payload.error ? 'error' : 'response_end', payload.error ? { error: payload.error } : { status: 'completed' }, record, currentTurn);
      } else {
        apply('provider_event', { provider: 'codex-rollout', provider_event_type: payload.type || 'event_msg', data: payload }, record, currentTurn);
      }
      continue;
    }
    if (record.type === 'response_item') {
      const turnId = payload.turn_id || currentTurn;
      if (turnId) currentTurn = turnId;
      if (payload.type === 'message') {
        const message = { role: payload.role || 'assistant', content: textFromContent(payload.content) };
        if (message.role === 'assistant') apply('response_text_delta', { delta: message.content }, record, turnId);
        else apply('request_message', { message }, record, turnId);
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        apply('response_tool_call', { tool_call: payload }, record, turnId);
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        apply('tool_result', { tool_result: payload }, record, turnId);
      } else {
        apply('provider_event', { provider: 'codex-rollout', provider_event_type: payload.type || 'response_item', data: payload }, record, turnId);
      }
      continue;
    }
    apply('provider_event', { provider: 'codex-rollout', provider_event_type: record.type || 'unknown', data: record }, record, currentTurn);
  }
  if (!session.ended_at && records.length) session.ended_at = records.at(-1).timestamp || null;
  return session;
}

function rolloutRecord(ordinal, timestamp, type, payload) {
  return { timestamp, ordinal, type, payload };
}

function sessionToRollout(session, options = {}) {
  const now = session.started_at || new Date().toISOString();
  const records = [rolloutRecord(0, now, 'session_meta', {
    id: session.session_id, session_id: session.session_id, timestamp: now,
    cwd: session.environment?.cwd || null, originator: options.originator || 'agent-data',
    cli_version: session.agent?.version || null, source: 'agent-data', model_provider: session.provider?.model_provider || null
  })];
  let ordinal = 1;
  for (const turn of session.turns || []) {
    const turnId = turn.turn_id || crypto.randomUUID();
    records.push(rolloutRecord(ordinal++, turn.timing?.request_start || now, 'event_msg', { type: 'task_started', turn_id: turnId, root_turn_id: turnId }));
    for (const message of turn.request?.messages || []) {
      records.push(rolloutRecord(ordinal++, turn.timing?.request_start || now, 'response_item', {
        type: 'message', role: message.role || 'user', content: [{ type: 'input_text', text: textFromContent(message.content) }], turn_id: turnId
      }));
    }
    if (turn.response?.text) records.push(rolloutRecord(ordinal++, turn.timing?.response_end || now, 'response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.response.text }], turn_id: turnId
    }));
    for (const call of turn.tool_calls || []) records.push(rolloutRecord(ordinal++, now, 'response_item', { type: call.type === 'custom_tool_call' ? 'custom_tool_call' : 'function_call', ...call, turn_id: turnId }));
    for (const result of turn.tool_results || []) records.push(rolloutRecord(ordinal++, now, 'response_item', { type: 'function_call_output', ...result, turn_id: turnId }));
    records.push(rolloutRecord(ordinal++, turn.timing?.response_end || session.ended_at || now, 'event_msg', {
      type: 'task_complete', turn_id: turnId, ...(turn.response?.error ? { error: turn.response.error } : {})
    }));
  }
  return records;
}

async function readRollout(file) { return rolloutToSession(await fsp.readFile(file, 'utf8')); }

async function writeRollout(file, session, options = {}) {
  const output = path.resolve(file);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const records = sessionToRollout(session, options);
  await fsp.writeFile(output, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  return { output, records, validation: validateSession(session) };
}

module.exports = { parseRollout, rolloutToSession, sessionToRollout, readRollout, writeRollout, textFromContent };
