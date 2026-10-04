const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSession } = require('@agent-data/core');
const { appendSessionIndex, syncSessionToCodex, resolveResumeThread } = require('@agent-data/codex-session');

const threadId = '11111111-1111-4111-8111-111111111111';

async function fixtureHome() {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-codex-index-'));
  const rollout = path.join(codexHome, 'sessions/2026/10/04', 'rollout-2026-10-04T00-00-00-' + threadId + '.jsonl');
  await fs.mkdir(path.dirname(rollout), { recursive: true });
  await fs.writeFile(rollout, JSON.stringify({
    timestamp: '2026-10-04T00:00:00Z', type: 'session_meta', payload: { id: threadId, timestamp: '2026-10-04T00:00:00Z', cwd: '/project' }
  }) + '\n');
  return { codexHome, rollout };
}

test('Codex index sync requires an actual rollout and is idempotent', async () => {
  const { codexHome } = await fixtureHome();
  const session = createSession({ sessionId: threadId, startedAt: '2026-10-04T00:00:00Z' });
  session.metadata.thread_name = 'Fix tests';
  assert.equal((await appendSessionIndex(session, { codexHome })).appended, true);
  assert.equal((await appendSessionIndex(session, { codexHome })).appended, false);
  const entries = (await fs.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries, [{ id: threadId, thread_name: 'Fix tests', updated_at: '2026-10-04T00:00:00Z' }]);
  const absent = createSession({ sessionId: '22222222-2222-4222-8222-222222222222' });
  assert.equal((await appendSessionIndex(absent, { codexHome })).reason, 'native_rollout_missing');
  await assert.rejects(resolveResumeThread(absent, { codexHome }), /No native Codex rollout/);
});

test('Codex header maps a factory session to native resume without overwriting its title', async () => {
  const { codexHome, rollout } = await fixtureHome();
  const index = path.join(codexHome, 'session_index.jsonl');
  const original = { id: threadId, thread_name: 'Original native title', updated_at: '2026-10-04T00:00:00Z' };
  await fs.writeFile(index, JSON.stringify(original) + '\n');
  const rawFile = path.join(codexHome, 'factory-raw.jsonl');
  await fs.writeFile(rawFile, JSON.stringify({ kind: 'request', payload: { headers: { 'thread-id': threadId } } }) + '\n');
  const session = createSession({ sessionId: 'factory-session', endedAt: '2026-10-04T00:01:00Z' });
  const synced = await syncSessionToCodex(session, { codexHome, rawFile });
  assert.equal(synced.results[0].entry.thread_name, 'Original native title');
  const resumed = await resolveResumeThread(session, { codexHome, rawFile });
  assert.deepEqual(resumed, { thread_id: threadId, rollout });
  assert.equal((await fs.readFile(index, 'utf8')).trim().split('\n').length, 2);
});
