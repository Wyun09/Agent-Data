const test = require('node:test');
const assert = require('node:assert/strict');
const { rolloutToSession, sessionToRollout } = require('@agent-data/session-schema');

const rollout = [
  { timestamp: '2026-10-04T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'native-session', cwd: '/project', cli_version: '0.160.0', model_provider: 'openai' } },
  { timestamp: '2026-10-04T00:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
  { timestamp: '2026-10-04T00:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }], turn_id: 'turn-1' } },
  { timestamp: '2026-10-04T00:00:03.000Z', ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }], turn_id: 'turn-1' } },
  { timestamp: '2026-10-04T00:00:04.000Z', ordinal: 4, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }
];

test('Codex rollout imports into the unified schema', () => {
  const session = rolloutToSession(rollout);
  assert.equal(session.schema_version, '1.0');
  assert.equal(session.session_id, 'native-session');
  assert.equal(session.provider.protocol, 'codex-rollout');
  assert.equal(session.turns[0].request.messages[0].content, 'fix it');
  assert.equal(session.turns[0].response.text, 'done');
  assert.equal(session.turns[0].response.status, 'completed');
  assert.equal(session.safety.risk_level, 'none');
});

test('unified session exports to Codex-compatible rollout records', () => {
  const session = rolloutToSession(rollout);
  const exported = sessionToRollout(session);
  assert.equal(exported[0].type, 'session_meta');
  assert.equal(exported[0].payload.id, 'native-session');
  assert.ok(exported.some((record) => record.type === 'response_item' && record.payload.role === 'assistant'));
  assert.ok(exported.some((record) => record.type === 'event_msg' && record.payload.type === 'task_complete'));
});
