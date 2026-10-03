const { StringDecoder } = require('node:string_decoder');

class SSEParser {
  constructor(options = {}) {
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.id = undefined;
    this.retry = undefined;
    this.onMalformed = options.onMalformed;
    this.decoder = new StringDecoder('utf8');
  }

  feed(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : this.decoder.write(Buffer.from(String(chunk), 'utf8'));
    const events = [];
    let match;
    while ((match = this.buffer.match(/^(.*?)(\r\n|\n|\r)/))) {
      const line = match[1];
      this.buffer = this.buffer.slice(match[0].length);
      this.consumeLine(line, events);
    }
    return events;
  }

  finish() {
    const events = [];
    this.buffer += this.decoder.end();
    if (this.buffer.length) {
      this.consumeLine(this.buffer, events);
      this.buffer = '';
    }
    this.dispatch(events);
    return events;
  }

  consumeLine(line, events) {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': this.event = value; break;
      case 'data': this.data.push(value); break;
      case 'id': if (!value.includes('\0')) this.id = value; break;
      case 'retry': if (/^\d+$/.test(value)) this.retry = Number(value); break;
      default: this.onMalformed?.(new Error(`unknown SSE field: ${field}`), line);
    }
  }

  dispatch(events) {
    if (!this.data.length && !this.event && this.id === undefined) return;
    events.push({ event: this.event || 'message', data: this.data.join('\n'), ...(this.id === undefined ? {} : { id: this.id }), ...(this.retry === undefined ? {} : { retry: this.retry }) });
    this.event = '';
    this.data = [];
    this.retry = undefined;
  }
}

function parseSSE(text, options) {
  const parser = new SSEParser(options);
  return parser.feed(text).concat(parser.finish());
}

module.exports = { SSEParser, parseSSE };
