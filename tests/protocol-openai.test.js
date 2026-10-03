const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSSE, normalizeSSEEvent, normalizeRequest, normalizeRawRecords } = require('@agent-data/protocol-openai');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

test('SSE parser handles split chunks and multiple data lines', () => {
  const parser = new (require('@agent-data/protocol-openai').SSEParser)();
  const events = [
    ...parser.feed('event: response.output_text.delta\ndata: {"delta":"hel'),
    ...parser.feed('lo"}\n\ndata: [DONE]\n\n')
  ];
  assert.deepEqual(events, [
    { event: 'response.output_text.delta', data: '{"delta":"hello"}' },
    { event: 'message', data: '[DONE]' }
  ]);
});

test('SSE parser preserves UTF-8 when a multibyte character crosses chunks', () => {
  const parser = new (require('@agent-data/protocol-openai').SSEParser)();
  const encoded = Buffer.from('event: response.output_text.delta\ndata: {"delta":"你好"}\n\n');
  const split = encoded.indexOf(Buffer.from('你')) + 1;
  const events = parser.feed(encoded.subarray(0, split)).concat(parser.feed(encoded.subarray(split)), parser.finish());
  assert.equal(JSON.parse(events[0].data).delta, '你好');
});

test('fixture replay preserves text, usage, and unknown events', () => {
  const events = parseSSE(fixture('openai-responses/basic.sse'));
  const canonical = events.map((event) => normalizeSSEEvent(event));
  assert.equal(canonical[1].type, 'response_text_delta');
  assert.equal(canonical[1].delta, 'Hello');
  assert.equal(canonical.at(-1).type, 'response_end');
  assert.equal(canonical.at(-1).usage.output_tokens, 2);

  const future = parseSSE(fixture('openai-responses/unknown-future-event.sse'))[0];
  const unknown = normalizeSSEEvent(future);
  assert.equal(unknown.type, 'provider_event');
  assert.equal(unknown.provider_event_type, 'response.future_event.v2');
});

test('malformed SSE JSON becomes a canonical error and raw data remains available', () => {
  const event = parseSSE(fixture('malformed/bad-json.sse'))[0];
  const canonical = normalizeSSEEvent(event);
  assert.equal(canonical.type, 'error');
  assert.equal(canonical.error.code, 'malformed_json');
  assert.match(canonical.raw_data, /not-json/);
});

test('request adapter emits messages and tool definitions', () => {
  const request = JSON.parse(fixture('openai-responses/request.json'));
  const result = normalizeRequest(request);
  assert.equal(result.events[0].type, 'request_start');
  assert.equal(result.events.filter((event) => event.type === 'request_message').length, 1);
  assert.equal(result.events.filter((event) => event.type === 'request_tool_definition').length, 1);
  assert.equal(result.events.at(-1).type, 'request_end');
});

test('raw replay creates a schema v1 session', () => {
  const records = [
    { session_id: 'replay-1', kind: 'session_start', recorded_at: '2026-10-03T00:00:00.000Z', payload: {} },
    { session_id: 'replay-1', kind: 'request', recorded_at: '2026-10-03T00:00:00.001Z', payload: { body: JSON.parse(fixture('openai-responses/request.json')) } },
    ...parseSSE(fixture('openai-responses/basic.sse')).map((event, index) => ({ session_id: 'replay-1', kind: 'sse_event', recorded_at: `2026-10-03T00:00:00.00${index + 2}Z`, payload: event })),
    { session_id: 'replay-1', kind: 'session_end', recorded_at: '2026-10-03T00:00:01.000Z', payload: {} }
  ];
  const session = normalizeRawRecords(records, { sessionId: 'replay-1' });
  assert.equal(session.schema_version, '1.0');
  assert.equal(session.provider.protocol, 'openai-responses');
  assert.match(session.turns[0].response.text, /Hello world/);
  assert.equal(session.turns[0].usage.output_tokens, 2);
});
