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
const { parseArgs, defaultUpstream } = require('@agent-data/cli');
const { resetCodexDaemon } = require('@agent-data/codex-daemon');
const { labelsFromVerification, computeReward } = require('@agent-data/rewards');
const { normalizeRawRecords } = require('@agent-data/protocol-openai');

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
  assert.match(text, /labels/);
  assert.ok(await fs.readFile(`${result.output}.manifest.json`, 'utf8'));
});

test('v0.2 argument parser preserves equals signs in values', () => {
  const parsed = parseArgs(['export', 'sft', '--output=a=b.jsonl']);
  assert.equal(parsed.options.output, 'a=b.jsonl');
});

test('Codex login and API key use different default upstreams', () => {
  assert.equal(defaultUpstream(), 'https://chatgpt.com/backend-api/codex');
  assert.equal(defaultUpstream('api-key'), 'https://api.openai.com/v1');
});

test('CLI accepts an explicit protocol bridge mode', () => {
  assert.equal(parseArgs(['proxy', '--protocol-bridge', 'responses-to-chat']).options.protocol_bridge, 'responses-to-chat');
});

test('reset-daemon removes a broken socket link and stale lock', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-data-codex-'));
  const control = path.join(codexHome, 'app-server-control');
  await fs.mkdir(control, { recursive: true });
  await fs.symlink(path.join(codexHome, 'missing.sock'), path.join(control, 'app-server-control.sock'));
  await fs.writeFile(path.join(control, 'app-server-startup.lock'), '');
  const report = await resetCodexDaemon({ codexHome, force: true });
  assert.equal(report.daemon_alive, false);
  assert.equal(report.removed.length, 2);
  await assert.rejects(fs.lstat(path.join(control, 'app-server-control.sock')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(control, 'app-server-startup.lock')), { code: 'ENOENT' });
});

test('verification results automatically become labels and reward metadata', () => {
  const passed = { verification_id: 'v1', kind: 'tests', success: true, timed_out: false };
  assert.deepEqual(labelsFromVerification(passed), ['verification:tests:passed', 'verification:passed']);
  const session = normalizeRawRecords([
    { session_id: 'label-session', kind: 'session_start', recorded_at: '2026-10-04T00:00:00Z', payload: {} },
    { session_id: 'label-session', kind: 'verification_result', recorded_at: '2026-10-04T00:00:01Z', payload: passed },
    { session_id: 'label-session', kind: 'label', recorded_at: '2026-10-04T00:00:01Z', payload: { label: 'verification:tests:passed', source: 'verification' } },
    { session_id: 'label-session', kind: 'label', recorded_at: '2026-10-04T00:00:01Z', payload: { label: 'verification:passed', source: 'verification' } }
  ], { sessionId: 'label-session' });
  assert.ok(session.labels.includes('verification:tests:passed'));
  assert.ok(session.labels.includes('verification:passed'));
  assert.ok(computeReward(session).labels.includes('verification:passed'));
});
