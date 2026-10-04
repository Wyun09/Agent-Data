const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSession, createCanonicalEvent, applyCanonicalEvent } = require('@agent-data/core');
const { captureEnvironment } = require('@agent-data/environment');
const { executeVerification } = require('@agent-data/verification');
const { selectSessions } = require('@agent-data/filters');
const { exportDataset } = require('@agent-data/exporters');
const { writeJson, sessionPath } = require('@agent-data/storage');
const { parseArgs } = require('@agent-data/cli');

test('v0.2 captures project metadata without source contents', () => {
  const environment = captureEnvironment({ cwd: process.cwd(), command: 'node' });
  assert.equal(environment.cwd, process.cwd());
  assert.equal(typeof environment.node, 'string');
  if (environment.git.root) {
    assert.equal(typeof environment.git.dirty, 'boolean');
  } else {
    assert.equal(environment.git.head, null);
    assert.equal(environment.git.changed_files, null);
  }
  assert.equal(environment.git.diff, undefined);
});

test('v0.2 verification records success and redacts output', async () => {
  const result = await executeVerification({
    command: [process.execPath, '-e', "console.log('api_key=sk-secret-value')"],
    cwd: process.cwd()
  });
  assert.equal(result.success, true);
  assert.equal(result.kind, 'command');
  assert.ok(!result.stdout_tail.includes('sk-secret-value'));
  assert.match(result.stdout_tail, /REDACTED/);
});

test('v0.2 filter deduplicates and rejects trivial sessions', () => {
  const make = (id, text) => {
    const session = createSession({ sessionId: id });
    applyCanonicalEvent(session, createCanonicalEvent('request_message', { message: { role: 'user', content: 'fix it' } }));
    applyCanonicalEvent(session, createCanonicalEvent('response_text_delta', { delta: text }));
    applyCanonicalEvent(session, createCanonicalEvent('response_end', { status: 'completed' }));
    return session;
  };
  const selection = selectSessions([make('long-a', 'This is a useful response with enough detail.'), make('long-b', 'This is a useful response with enough detail.'), make('short', 'ok')]);
  assert.equal(selection.selected.length, 1);
  assert.ok(selection.reports.find((item) => item.session_id === 'long-b').reasons.includes('duplicate'));
  assert.ok(selection.reports.find((item) => item.session_id === 'short').reasons.includes('trivial_trajectory'));
});

test('v0.2 exports an SFT manifest and sanitized messages', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-data-v02-'));
  const session = createSession({ sessionId: 'export-session', provider: { protocol: 'openai-responses', model: 'mock' } });
  applyCanonicalEvent(session, createCanonicalEvent('request_message', { message: { role: 'user', content: 'Please fix this real bug.' } }));
  applyCanonicalEvent(session, createCanonicalEvent('response_text_delta', { delta: 'I fixed the bug and verified the regression test successfully.' }));
  applyCanonicalEvent(session, createCanonicalEvent('response_end', { status: 'completed' }));
  await writeJson(sessionPath(dataDir, session.session_id), session);
  const result = await exportDataset({ dataDir, type: 'sft' });
  assert.equal(result.exported_sessions, 1);
  const text = await fs.readFile(result.output, 'utf8');
  assert.match(text, /Please fix this real bug/);
  assert.ok(await fs.readFile(`${result.output}.manifest.json`, 'utf8'));
});

test('v0.2 argument parser preserves equals signs in values', () => {
  const parsed = parseArgs(['export', 'sft', '--output=a=b.jsonl']);
  assert.equal(parsed.options.output, 'a=b.jsonl');
});
