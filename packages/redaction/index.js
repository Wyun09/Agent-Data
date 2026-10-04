const os = require('node:os');

const REDACTED = '[REDACTED]';
const AUTH_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'cookie',
  'set-cookie'
]);

function isSensitiveHeader(name) {
  const lower = String(name).toLowerCase();
  return AUTH_HEADER_NAMES.has(lower) || lower.includes('token') || lower.includes('secret') || lower.includes('password');
}

function isSensitiveFieldName(name) {
  return /^(authorization|proxy[_-]authorization|x[_-]api[_-]key|api[_-]?key|x[_-](?:auth|access)[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|cookie|set[_-]cookie)$/i.test(String(name))
    || /(?:^|[_-])(?:api[_-]?key|access[_-]token|refresh[_-]token|id[_-]token|secret|password)$/i.test(String(name));
}

function redactHeaderValue(name, value) {
  if (isSensitiveHeader(name)) return REDACTED;
  return redactString(String(value), { mode: 'safe', headerName: name });
}

function redactHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = Array.isArray(value)
      ? value.map((item) => redactHeaderValue(name, item))
      : redactHeaderValue(name, value);
  }
  return out;
}

function redactString(input, options = {}) {
  const mode = options.mode || 'safe';
  let value = String(input);
  // SSE data and tool arguments can contain serialized credential fields.
  if (/^\s*[\[{]/.test(value)) {
    try { return JSON.stringify(redact(JSON.parse(value), options)); } catch { /* redact malformed text below */ }
  }

  // Credential values are always removed, even in privacy mode "off".
  value = value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, REDACTED);
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  value = value.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,})\b/g, REDACTED);
  value = value.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  value = value.replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*(['"]?)[^\s,'"}&]+\2/gi, `$1=${REDACTED}`);
  value = value.replace(/(authorization\s*[:=]\s*)([^\s,;}]+)/gi, `$1${REDACTED}`);

  if (mode === 'strict') {
    const home = os.homedir();
    if (home) value = value.split(home).join('~');
    value = value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED);
    value = value.replace(/(?:\/home\/|\/Users\/)[^/\s]+/g, REDACTED);
  }
  return value;
}

function redact(value, options = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, options);
  if (Array.isArray(value)) return value.map((item) => redact(item, options));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveFieldName(key)) out[key] = REDACTED;
      else if (key.toLowerCase() === 'headers') out[key] = redactHeaders(item);
      else out[key] = redact(item, options);
    }
    return out;
  }
  return value;
}

function redactRequest(request, options = {}) {
  const output = { ...request };
  if (request.headers) output.headers = redactHeaders(request.headers);
  if (request.body_text !== undefined) output.body_text = redactString(request.body_text, options);
  if (request.body !== undefined) output.body = redact(request.body, options);
  return redact(output, options);
}

module.exports = {
  REDACTED,
  isSensitiveHeader,
  isSensitiveFieldName,
  redactHeaders,
  redactString,
  redact,
  redactRequest
};
