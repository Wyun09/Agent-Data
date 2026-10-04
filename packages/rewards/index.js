function verificationSignals(session) {
  const checks = Array.isArray(session?.verification) ? session.verification : [];
  const tests = checks.filter((item) => item.kind === 'tests');
  const builds = checks.filter((item) => item.kind === 'build');
  const successful = (items) => items.length ? items.filter((item) => item.success).length / items.length : null;
  return {
    tests_passed: successful(tests),
    build_passed: successful(builds),
    verification_passed: successful(checks)
  };
}

function trajectorySignals(session) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  const response = turns.at(-1)?.response || {};
  const errors = (session?.events || []).filter((event) => event.type === 'error');
  const textLength = turns.reduce((sum, turn) => sum + String(turn.response?.text || '').length, 0);
  const toolCalls = turns.reduce((sum, turn) => sum + (turn.tool_calls?.length || 0), 0);
  return {
    response_completed: response.status === 'completed' ? 1 : 0,
    no_recorded_error: errors.length ? 0 : 1,
    nontrivial_trajectory: textLength >= 20 || toolCalls > 0 ? 1 : 0
  };
}

function averageAvailable(signals) {
  const values = Object.values(signals).filter((value) => typeof value === 'number');
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function computeReward(session) {
  const verification = verificationSignals(session);
  const trajectory = trajectorySignals(session);
  const combined = {
    ...verification,
    ...trajectory
  };
  const weights = {
    tests_passed: 0.25,
    build_passed: 0.15,
    verification_passed: 0.2,
    response_completed: 0.15,
    no_recorded_error: 0.1,
    nontrivial_trajectory: 0.15
  };
  let weighted = 0;
  let totalWeight = 0;
  for (const [name, weight] of Object.entries(weights)) {
    if (typeof combined[name] !== 'number') continue;
    weighted += combined[name] * weight;
    totalWeight += weight;
  }
  return {
    value: totalWeight ? Number((weighted / totalWeight).toFixed(6)) : 0,
    signals: combined,
    labels: automaticLabels(session),
    computed_at: new Date().toISOString()
  };
}

function labelsFromVerification(result = {}) {
  const labels = [];
  const kind = String(result.kind || 'command');
  const name = kind === 'tests' ? 'tests' : kind === 'build' ? 'build' : 'verification';
  labels.push(`verification:${name}:${result.success ? 'passed' : 'failed'}`);
  if (result.success) labels.push('verification:passed');
  else if (result.timed_out) labels.push('verification:timed_out');
  else labels.push('verification:failed');
  return labels;
}

function automaticLabels(session) {
  const labels = new Set(session?.labels || []);
  for (const result of session?.verification || []) for (const label of labelsFromVerification(result)) labels.add(label);
  if (session?.safety?.risk_level && session.safety.risk_level !== 'none') labels.add(`safety:risk:${session.safety.risk_level}`);
  return [...labels];
}

function attachReward(session) {
  const reward = computeReward(session);
  session.reward = reward;
  return reward;
}

module.exports = { verificationSignals, trajectorySignals, computeReward, attachReward, labelsFromVerification, automaticLabels };
