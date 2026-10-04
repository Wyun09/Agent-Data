const { createCanonicalEvent } = require('@agent-data/core');
const { SSEParser, parseSSE } = require('./sse');

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body !== 'string' || !body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    return { input: body };
  }
}

function requestMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (typeof item === 'string') return { role: 'user', content: item };
    if (!item || typeof item !== 'object') return item;
    const role = item.role || (item.type === 'message' ? item.role : undefined);
    if (role) return { ...item, role };
    return item;
  });
}

function normalizeRequest(body, context = {}) {
  const request = parseBody(body);
  const timestamp = context.timestamp;
  const events = [createCanonicalEvent('request_start', {
    request: {
      model: request.model || null,
      instructions: request.instructions || null,
      stream: request.stream !== false,
      temperature: request.temperature,
      reasoning: request.reasoning,
      metadata: request.metadata || {}
    }
  }, timestamp)];
  for (const message of requestMessages(request.input ?? request.messages)) {
    if (message?.type === 'function_call_output' || message?.type === 'tool_result') {
      events.push(createCanonicalEvent('tool_result', {
        tool_result: {
          call_id: message.call_id,
          output: message.output,
          type: message.type
        }
      }, timestamp));
    } else if (message?.type === 'function_call' || message?.type === 'tool_call') {
      events.push(createCanonicalEvent('tool_call', {
        tool_call: message
      }, timestamp));
    } else {
      events.push(createCanonicalEvent('request_message', { message }, timestamp));
    }
  }
  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) events.push(createCanonicalEvent('request_tool_definition', { tool }, timestamp));
  }
  events.push(createCanonicalEvent('request_end', {}, timestamp));
  return { request, events };
}

function parseEventData(sse) {
  if (!sse.data || sse.data === '[DONE]') return sse.data;
  try {
    return JSON.parse(sse.data);
  } catch (error) {
    return { __parse_error: error.message, raw_data: sse.data };
  }
}

function normalizeSSEEvent(sse, context = {}) {
  const type = sse.event || 'message';
  const payload = parseEventData(sse);
  const timestamp = context.timestamp;
  if (payload === '[DONE]') return createCanonicalEvent('response_end', { status: 'completed' }, timestamp);
  if (payload && payload.__parse_error) {
    return createCanonicalEvent('error', {
      error: { source: 'sse', code: 'malformed_json', message: payload.__parse_error },
      provider_event_type: type,
      raw_data: payload.raw_data
    }, timestamp);
  }
  const response = payload && typeof payload === 'object' ? payload : {};
  switch (type) {
    case 'response.created':
    case 'response.in_progress':
      {
        const created = response.response || response;
      return createCanonicalEvent('response_start', {
        response: {
          id: created.id,
          status: created.status,
          model: created.model
        }
      }, timestamp);
      }
    case 'response.output_text.delta':
      return createCanonicalEvent('response_text_delta', {
        response_id: response.response_id,
        item_id: response.item_id,
        output_index: response.output_index,
        content_index: response.content_index,
        delta: response.delta || ''
      }, timestamp);
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return createCanonicalEvent('response_reasoning_delta', {
        response_id: response.response_id,
        item_id: response.item_id,
        delta: response.delta || response.text || ''
      }, timestamp);
    case 'response.function_call_arguments.delta':
      return createCanonicalEvent('response_tool_call', {
        tool_call: {
          id: response.call_id || response.item_id,
          call_id: response.call_id,
          name: response.name,
          arguments_delta: response.delta || ''
        }
      }, timestamp);
    case 'response.function_call_arguments.done':
      return createCanonicalEvent('response_tool_call', {
        tool_call: {
          id: response.call_id || response.item_id,
          call_id: response.call_id,
          item_id: response.item_id,
          name: response.name,
          arguments: response.arguments,
          status: 'completed'
        }
      }, timestamp);
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const item = response.item || response.output_item || response;
      if (item && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
        return createCanonicalEvent('response_tool_call', {
          tool_call: {
            id: item.call_id || item.id || response.item_id,
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments,
            status: item.status,
            type: item.type
          }
        }, timestamp);
      }
      return createCanonicalEvent('provider_event', {
        provider: 'openai-responses',
        provider_event_type: type,
        data: response
      }, timestamp);
    }
    case 'response.usage':
      return createCanonicalEvent('response_usage', { usage: response.usage || response }, timestamp);
    case 'response.completed':
      return createCanonicalEvent('response_end', {
        response_id: response.response?.id || response.id,
        status: response.response?.status || response.status || 'completed',
        response: response.response,
        usage: response.response?.usage || response.usage
      }, timestamp);
    case 'response.failed':
    case 'response.incomplete':
      return createCanonicalEvent('error', {
        error: response.error || response,
        provider_event_type: type
      }, timestamp);
    case 'error':
      return createCanonicalEvent('error', { error: response.error || response }, timestamp);
    default:
      return createCanonicalEvent('provider_event', {
        provider: 'openai-responses',
        provider_event_type: type,
        data: payload
      }, timestamp);
  }
}

function normalizeRawRecords(records, options = {}) {
  const sessionId = options.sessionId || records.find((item) => item.session_id)?.session_id;
  const first = records.find((item) => item.kind === 'session_start');
  const session = require('@agent-data/core').createSession({
    sessionId,
    startedAt: first?.recorded_at || records[0]?.recorded_at,
    agent: first?.payload?.agent || {},
    provider: first?.payload?.provider && typeof first.payload.provider === 'object'
      ? first.payload.provider
      : { protocol: 'openai-responses' },
    environment: first?.payload?.environment || {},
    privacy: { mode: options.privacyMode || 'safe' },
    metadata: { raw_records: records.length, ...(first?.payload?.metadata || {}) }
  });
  const core = require('@agent-data/core');
  for (const record of records) {
    const context = { timestamp: record.recorded_at };
    let events = [];
    switch (record.kind) {
      case 'session_start':
        events = [createCanonicalEvent('session_start', record.payload || {}, record.recorded_at)];
        break;
      case 'request': {
        const normalized = normalizeRequest(record.payload?.body ?? record.payload?.body_text, context);
        events = normalized.events;
        if (normalized.request.model) session.provider.model = normalized.request.model;
        break;
      }
      case 'response_start':
        events = [createCanonicalEvent('response_start', record.payload || {}, record.recorded_at)];
        break;
      case 'sse_event':
        events = [normalizeSSEEvent(record.payload || {}, context)];
        break;
      case 'response_end':
        events = [createCanonicalEvent('response_end', record.payload || {}, record.recorded_at)];
        break;
      case 'upstream_error':
      case 'proxy_error':
      case 'client_disconnect':
        events = [createCanonicalEvent('error', { error: record.payload || {}, source: record.kind }, record.recorded_at)];
        break;
      case 'verification_result':
        events = [createCanonicalEvent('verification_result', { result: record.payload || {} }, record.recorded_at)];
        break;
      case 'reward_signal':
        events = [createCanonicalEvent('reward_signal', { reward: record.payload || {} }, record.recorded_at)];
        break;
      case 'session_end':
        events = [createCanonicalEvent('session_end', record.payload || {}, record.recorded_at)];
        break;
      default:
        events = [createCanonicalEvent('provider_event', {
          provider: 'openai-responses',
          provider_event_type: record.kind,
          data: record.payload
        }, record.recorded_at)];
    }
    for (const event of events) {
      if (record.turn_id && !event.turn_id) event.turn_id = record.turn_id;
      core.applyCanonicalEvent(session, event);
    }
  }
  if (!session.ended_at && records.length) session.ended_at = records[records.length - 1].recorded_at;
  session.metadata.raw_records = records.length;
  return session;
}

module.exports = {
  SSEParser,
  parseSSE,
  parseBody,
  normalizeRequest,
  normalizeSSEEvent,
  normalizeRawRecords
};
