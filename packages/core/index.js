const crypto = require('node:crypto');

const SCHEMA_VERSION = '1.0';

const CANONICAL_EVENT_TYPES = Object.freeze([
  'session_start',
  'session_end',
  'request_start',
  'request_message',
  'request_tool_definition',
  'request_end',
  'response_start',
  'response_text_delta',
  'response_reasoning_delta',
  'response_tool_call',
  'response_usage',
  'response_end',
  'tool_call',
  'tool_result',
  'verification_start',
  'verification_result',
  'reward_signal',
  'label',
  'error',
  'provider_event'
]);

function nowIso() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

function createSession(options = {}) {
  const startedAt = options.started_at || options.startedAt || nowIso();
  const sessionId = options.session_id || options.sessionId || id();
  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    agent: {
      name: options.agent?.name || 'unknown',
      version: options.agent?.version || null,
      ...(options.agent || {})
    },
    provider: {
      protocol: options.provider?.protocol || 'unknown',
      model: options.provider?.model || null,
      ...(options.provider || {})
    },
    started_at: startedAt,
    ended_at: options.ended_at || options.endedAt || null,
    environment: options.environment || {},
    turns: options.turns || [],
    verification: options.verification || [],
    reward: options.reward || {},
    labels: options.labels || [],
    privacy: {
      mode: options.privacy?.mode || 'safe',
      ...(options.privacy || {})
    },
    metadata: options.metadata || {},
    events: options.events || []
  };
}

function createCanonicalEvent(type, data = {}, timestamp = nowIso()) {
  const eventId = data.event_id || id();
  return {
    ...data,
    event_id: eventId,
    type,
    timestamp: data.timestamp || timestamp
  };
}

function ensureTurn(session, turnId) {
  if (!Array.isArray(session.turns)) session.turns = [];
  let turn = turnId ? session.turns.find((item) => item.turn_id === turnId) : session.turns.at(-1);
  if (!turn) {
    session.turns.push({
      turn_id: turnId || id(),
      request: { messages: [], tools: [], metadata: {} },
      response: { text: '', reasoning: '', status: null, error: null },
      tool_calls: [],
      tool_results: [],
      usage: {},
      timing: {}
    });
    turn = session.turns.at(-1);
  }
  turn.request ||= { messages: [], tools: [], metadata: {} };
  turn.response ||= { text: '', reasoning: '', status: null, error: null };
  turn.tool_calls ||= [];
  turn.tool_results ||= [];
  turn.usage ||= {};
  turn.timing ||= {};
  return turn;
}

function mergeToolCall(turn, call) {
  const key = call.id || call.call_id || call.item_id;
  if (!key) {
    turn.tool_calls.push(call);
    return;
  }
  const existing = turn.tool_calls.find((item) => [item.id, item.call_id, item.item_id].includes(key)
    || (call.item_id && [item.id, item.call_id, item.item_id].includes(call.item_id)));
  if (!existing) turn.tool_calls.push({ ...call, id: call.id || key });
  else {
    const delta = `${existing.arguments_delta || ''}${call.arguments_delta || ''}`;
    for (const [name, value] of Object.entries(call)) if (value !== undefined) existing[name] = value;
    if (call.arguments_delta !== undefined) existing.arguments_delta = delta;
  }
}

function applyCanonicalEvent(session, event) {
  if (!session.events) session.events = [];
  session.events.push(event);
  const hasTurn = /^(request_|response_|tool_)/.test(event.type) || event.type === 'error';
  const turn = hasTurn ? ensureTurn(session, event.turn_id) : null;
  switch (event.type) {
    case 'session_start':
      session.started_at ||= event.timestamp;
      if (event.environment) session.environment = { ...session.environment, ...event.environment };
      if (event.agent) session.agent = { ...session.agent, ...event.agent };
      if (event.provider && typeof event.provider === 'object') session.provider = { ...session.provider, ...event.provider };
      if (event.metadata && typeof event.metadata === 'object') session.metadata = { ...session.metadata, ...event.metadata };
      break;
    case 'session_end':
      session.ended_at = event.timestamp;
      break;
    case 'request_start':
      turn.timing.request_start = event.timestamp;
      if (event.request) turn.request = { ...turn.request, ...event.request };
      break;
    case 'request_message':
      turn.request.messages ||= [];
      if (event.message !== undefined) turn.request.messages.push(event.message);
      break;
    case 'request_tool_definition':
      turn.request.tools ||= [];
      if (event.tool !== undefined) turn.request.tools.push(event.tool);
      break;
    case 'request_end':
      turn.timing.request_end = event.timestamp;
      break;
    case 'response_start':
      turn.timing.response_start = event.timestamp;
      break;
    case 'response_text_delta':
      turn.response.text = `${turn.response.text || ''}${event.delta || ''}`;
      if (!turn.timing.first_token) turn.timing.first_token = event.timestamp;
      break;
    case 'response_reasoning_delta':
      turn.response.reasoning = `${turn.response.reasoning || ''}${event.delta || ''}`;
      if (!turn.timing.first_token) turn.timing.first_token = event.timestamp;
      break;
    case 'response_tool_call':
    case 'tool_call':
      mergeToolCall(turn, event.tool_call || event);
      if (!turn.timing.first_token) turn.timing.first_token = event.timestamp;
      break;
    case 'tool_result':
      turn.tool_results.push(event.tool_result || event);
      break;
    case 'response_usage':
      turn.usage = { ...turn.usage, ...(event.usage || {}) };
      break;
    case 'response_end':
      turn.response.status = event.status || event.response?.status || turn.response.status;
      turn.response.id = event.response?.id || event.response_id || turn.response.id;
      turn.timing.response_end = event.timestamp;
      if (event.latency_ms !== undefined) turn.timing.latency_ms = event.latency_ms;
      if (event.time_to_first_token_ms !== undefined) turn.timing.time_to_first_token_ms = event.time_to_first_token_ms;
      if (event.usage) turn.usage = { ...turn.usage, ...event.usage };
      break;
    case 'error':
      turn.response.error = event.error || event.message || event.data || turn.response.error;
      break;
    case 'verification_result':
      session.verification ||= [];
      session.verification.push(event.result || event);
      break;
    case 'reward_signal':
      session.reward ||= {};
      session.reward = { ...session.reward, ...(event.reward || event.result || {}) };
      break;
    case 'label':
      session.labels ||= [];
      if (event.label !== undefined) session.labels.push(event.label);
      break;
    default:
      break;
  }
  return session;
}

function validateSession(session) {
  const errors = [];
  if (!session || typeof session !== 'object') return { valid: false, errors: ['session must be an object'] };
  if (session.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (typeof session.session_id !== 'string' || !session.session_id) errors.push('session_id is required');
  for (const key of ['agent', 'provider', 'environment', 'turns', 'verification', 'reward', 'labels', 'privacy']) {
    if (session[key] === undefined) errors.push(`${key} is required`);
  }
  if (!Array.isArray(session.turns)) errors.push('turns must be an array');
  if (!Array.isArray(session.events)) errors.push('events must be an array');
  if (session.events) {
    for (const event of session.events) {
      if (!event || typeof event.type !== 'string') errors.push('each event requires a type');
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  CANONICAL_EVENT_TYPES,
  nowIso,
  createSession,
  createCanonicalEvent,
  applyCanonicalEvent,
  validateSession
};
