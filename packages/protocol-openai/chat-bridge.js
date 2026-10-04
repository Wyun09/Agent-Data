const crypto = require('node:crypto');
const { SSEParser } = require('@agent-data/core/sse');

function unsupported(message) {
  return Object.assign(new Error(message), { code: 'unsupported_chat_bridge_input', statusCode: 400 });
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part) => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) return { type: 'text', text: part.text || '' };
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    throw unsupported('Chat bridge cannot represent content type: ' + part.type);
  });
}

function responsesToChat(request) {
  if (request.previous_response_id) throw unsupported('Chat bridge requires full input history; previous_response_id is not supported');
  const customTools = new Set();
  const messages = [];
  if (request.instructions) messages.push({ role: 'system', content: request.instructions });
  const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input || [];
  if (!Array.isArray(input)) throw unsupported('Responses input must be a string or an array');
  for (const item of input) {
    if (item.type === 'reasoning') continue; // Chat models have no encrypted reasoning history field.
    if (item.role) {
      messages.push({ role: item.role, content: textContent(item.content) });
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      let message = messages.at(-1);
      if (message?.role !== 'assistant' || !message.tool_calls) {
        message = { role: 'assistant', content: null, tool_calls: [] };
        messages.push(message);
      }
      message.tool_calls.push({
        id: item.call_id || item.id, type: 'function',
        function: { name: item.name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input || '' }) : item.arguments || '{}' }
      });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: textContent(item.output) });
    } else throw unsupported('Chat bridge cannot represent input item: ' + item.type);
  }
  const tools = (request.tools || []).map((tool) => {
    if (tool.type === 'custom') {
      customTools.add(tool.name);
      return { type: 'function', function: { name: tool.name, description: tool.description, parameters: {
        type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false
      } } };
    }
    if (tool.type !== 'function') throw unsupported('Chat bridge supports function/custom tools; unsupported tool: ' + tool.type);
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters || {}, strict: tool.strict } };
  });
  let toolChoice = request.tool_choice;
  if (toolChoice?.type === 'function' || toolChoice?.type === 'custom') {
    toolChoice = { type: 'function', function: { name: toolChoice.name } };
  } else if (typeof toolChoice === 'object') throw unsupported('Unsupported Chat bridge tool_choice');
  const chat = { model: request.model, messages, stream: request.stream !== false };
  if (tools.length) chat.tools = tools;
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls']) if (request[key] !== undefined) chat[key] = request[key];
  if (request.max_output_tokens !== undefined) chat.max_tokens = request.max_output_tokens;
  if (request.reasoning?.effort) chat.reasoning_effort = request.reasoning.effort;
  if (chat.stream) chat.stream_options = { include_usage: true };
  return { chat, customTools };
}

function responseUsage(usage = {}) {
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: input, output_tokens: output, total_tokens: usage.total_tokens ?? input + output,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 }
  };
}

class ChatToResponses {
  constructor(request, customTools = new Set()) {
    this.request = request;
    this.customTools = customTools;
    this.id = 'resp_' + crypto.randomUUID();
    this.sequence = 0;
    this.output = [];
    this.calls = new Map();
    this.started = false;
    this.terminal = false;
    this.finished = false;
    this.usage = {};
    this.status = 'in_progress';
  }

  response() {
    return {
      id: this.id, object: 'response', created_at: this.createdAt || Math.floor(Date.now() / 1000),
      status: this.status, model: this.model || this.request.model, output: this.output,
      error: this.error || null, incomplete_details: this.incompleteDetails || null,
      parallel_tool_calls: this.request.parallel_tool_calls ?? true,
      usage: responseUsage(this.usage)
    };
  }

  event(type, data = {}) {
    return { type, sequence_number: this.sequence++, ...data };
  }

  start(chunk = {}) {
    if (this.started) return [];
    this.started = true;
    this.model = chunk.model || this.request.model;
    this.createdAt = chunk.created || Math.floor(Date.now() / 1000);
    return [this.event('response.created', { response: this.response() }), this.event('response.in_progress', { response: this.response() })];
  }

  consume(chunk) {
    if (this.terminal) return [];
    const events = this.start(chunk);
    if (chunk.error) return events.concat(this.fail(chunk.error));
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return events;
    const delta = choice.delta || choice.message || {};
    if (delta.content) {
      if (!this.message) {
        this.message = { id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
        this.messageIndex = this.output.length;
        this.output.push(this.message);
        events.push(this.event('response.output_item.added', { output_index: this.messageIndex, item: { ...this.message, content: [] } }));
        this.message.content.push({ type: 'output_text', text: '', annotations: [] });
        events.push(this.event('response.content_part.added', { output_index: this.messageIndex, item_id: this.message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
      }
      this.message.content[0].text += delta.content;
      events.push(this.event('response.output_text.delta', { item_id: this.message.id, output_index: this.messageIndex, content_index: 0, delta: delta.content }));
    }
    for (const [position, call] of (delta.tool_calls || []).entries()) {
      const index = call.index ?? position;
      let state = this.calls.get(index);
      if (!state) {
        state = { index: this.output.length, name: '', arguments: '', call_id: call.id || 'call_' + crypto.randomUUID(), item_id: 'fc_' + crypto.randomUUID(), added: false };
        this.calls.set(index, state);
        this.output.push(null);
      }
      if (call.id) state.call_id = call.id;
      if (call.function?.name) state.name += call.function.name;
      const args = call.function?.arguments || '';
      state.arguments += args;
      if (!state.added && state.name) {
        state.added = true;
        const custom = this.customTools.has(state.name);
        state.custom = custom;
        this.output[state.index] = { id: state.item_id, type: custom ? 'custom_tool_call' : 'function_call', call_id: state.call_id, name: state.name, status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) };
        events.push(this.event('response.output_item.added', { output_index: state.index, item: { ...this.output[state.index] } }));
      }
      if (state.added && !state.custom && args) {
        this.output[state.index].arguments = state.arguments;
        events.push(this.event('response.function_call_arguments.delta', { item_id: state.item_id, output_index: state.index, delta: args }));
      }
    }
    if (choice.finish_reason) {
      this.finished = true;
      if (choice.finish_reason === 'length') this.incompleteDetails = { reason: 'max_output_tokens' };
      if (choice.finish_reason === 'content_filter') this.incompleteDetails = { reason: 'content_filter' };
    }
    return events;
  }

  fail(error) {
    if (this.terminal) return [];
    this.terminal = true;
    this.status = 'failed';
    this.error = typeof error === 'string' ? { code: 'chat_bridge_error', message: error } : error;
    return [this.event('response.failed', { response: this.response(), error: this.error })];
  }

  finish(done = false) {
    if (this.terminal) return [];
    const events = this.start();
    if (!done && !this.finished) return events.concat(this.fail({ code: 'incomplete_chat_stream', message: 'Upstream closed before a finish reason or [DONE]' }));
    if (this.message) {
      this.message.status = 'completed';
      const location = { item_id: this.message.id, output_index: this.messageIndex, content_index: 0 };
      events.push(this.event('response.output_text.done', { ...location, text: this.message.content[0].text }));
      events.push(this.event('response.content_part.done', { ...location, part: this.message.content[0] }));
      events.push(this.event('response.output_item.done', { output_index: this.messageIndex, item: this.message }));
    }
    for (const state of this.calls.values()) {
      if (!state.added) return events.concat(this.fail({ code: 'invalid_tool_call', message: 'Tool call has no function name' }));
      const item = this.output[state.index];
      if (state.custom) {
        try { item.input = JSON.parse(state.arguments).input; } catch { return events.concat(this.fail({ code: 'invalid_custom_tool_input', message: 'Custom tool requires JSON {input:string}' })); }
        if (typeof item.input !== 'string') return events.concat(this.fail({ code: 'invalid_custom_tool_input', message: 'Custom tool input must be a string' }));
        events.push(this.event('response.custom_tool_call_input.delta', { item_id: state.item_id, output_index: state.index, delta: item.input }));
        events.push(this.event('response.custom_tool_call_input.done', { item_id: state.item_id, output_index: state.index, input: item.input }));
      } else {
        item.arguments = state.arguments;
        events.push(this.event('response.function_call_arguments.done', { item_id: state.item_id, output_index: state.index, name: state.name, arguments: state.arguments }));
      }
      item.status = 'completed';
      events.push(this.event('response.output_item.done', { output_index: state.index, item }));
    }
    this.terminal = true;
    this.status = this.incompleteDetails ? 'incomplete' : 'completed';
    events.push(this.event('response.' + this.status, { response: this.response() }));
    return events;
  }
}

function encodeEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

module.exports = { responsesToChat, responseUsage, ChatToResponses, encodeEvent };
