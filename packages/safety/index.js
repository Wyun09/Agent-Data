const { redact } = require('@agent-data/redaction');

const SEVERITY = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
const RULES = Object.freeze([
  { id: 'destructive-filesystem', severity: 'high', pattern: /\b(?:rm\s+-[a-z]*r[a-z]*f|mkfs(?:\.[a-z0-9]+)?|wipefs|dd\s+if=|shred\s+)/i },
  { id: 'shell-pipe-exec', severity: 'high', pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|fi)?sh\b/i },
  { id: 'credential-access', severity: 'high', pattern: /(?:\.ssh\/|\.aws\/credentials|auth\.json|OPENAI_API_KEY|ANTHROPIC_API_KEY|PRIVATE KEY)/i },
  { id: 'privilege-escalation', severity: 'medium', pattern: /\b(?:sudo|doas|su\s+-)\b/i },
  { id: 'force-reset', severity: 'medium', pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)\b/i },
  { id: 'network-write', severity: 'medium', pattern: /\b(?:curl|wget)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data(?:-raw)?|--upload-file|-T\s)/i },
  { id: 'process-control', severity: 'medium', pattern: /\b(?:kill\s+-9|pkill|shutdown|reboot)\b/i }
]);

function excerpt(value, max = 240) {
  return redact(String(value), { mode: 'safe' }).replace(/\s+/g, ' ').trim().slice(0, max);
}

function walk(value, path = '$', output = []) {
  if (typeof value === 'string') {
    for (const rule of RULES) {
      if (rule.pattern.test(value)) output.push({
        rule: rule.id, severity: rule.severity, path, excerpt: excerpt(value),
        source: 'request_filter'
      });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, output));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, output);
  }
  return output;
}

function inspectDangerousCommands(value) {
  const findings = walk(value).filter((item, index, all) => all.findIndex((other) => other.rule === item.rule && other.path === item.path) === index);
  const riskLevel = findings.reduce((level, finding) => SEVERITY[finding.severity] > SEVERITY[level] ? finding.severity : level, 'low');
  return {
    detected: findings.length > 0,
    risk_level: findings.length ? riskLevel : 'none',
    findings,
    labels: [...new Set(findings.map((finding) => `safety:${finding.rule}`))]
  };
}

module.exports = { RULES, SEVERITY, inspectDangerousCommands, excerpt };
