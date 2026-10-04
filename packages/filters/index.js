const crypto = require('node:crypto');
const { validateSession } = require('@agent-data/core');
const { computeReward } = require('@agent-data/rewards');

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sessionFingerprint(session) {
  const turn = session?.turns?.[0] || {};
  const prompt = turn.request?.messages || [];
  const response = turn.response?.text || '';
  const tools = turn.tool_calls || [];
  return crypto.createHash('sha256').update(stable({ prompt, response, tools })).digest('hex');
}

function qualityReport(session, options = {}) {
  const validation = validateSession(session);
  const reasons = [...validation.errors];
  const events = Array.isArray(session?.events) ? session.events : [];
  const errors = events.filter((event) => event.type === 'error');
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  const textLength = turns.reduce((sum, turn) => sum + String(turn.response?.text || '').trim().length, 0);
  const toolCalls = turns.reduce((sum, turn) => sum + (turn.tool_calls?.length || 0), 0);
  const failedVerification = (session?.verification || []).some((item) => item.success === false);
  if (errors.length && !options.include_errors) reasons.push('recorded_error');
  if (failedVerification && !options.include_failed) reasons.push('verification_failed');
  if (!options.include_trivial && textLength < (options.min_response_chars || 20) && toolCalls === 0) reasons.push('trivial_trajectory');
  const reward = session.reward?.value === undefined ? computeReward(session) : session.reward;
  return {
    include: reasons.length === 0,
    reasons,
    fingerprint: sessionFingerprint(session),
    reward: reward?.value ?? 0,
    metrics: { text_chars: textLength, tool_calls: toolCalls, errors: errors.length, verifications: (session?.verification || []).length }
  };
}

function selectSessions(sessions, options = {}) {
  const seen = new Set();
  const selected = [];
  const reports = [];
  for (const session of sessions) {
    const report = qualityReport(session, options);
    if (seen.has(report.fingerprint)) {
      report.include = false;
      report.reasons.push('duplicate');
    }
    if (report.include) {
      seen.add(report.fingerprint);
      selected.push(session);
    }
    reports.push({ session_id: session.session_id, ...report });
  }
  return { selected, reports };
}

module.exports = { stable, sessionFingerprint, qualityReport, selectSessions };
