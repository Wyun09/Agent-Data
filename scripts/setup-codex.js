#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(process.argv[2] || '');
if (!file) throw new Error('config path is required');

const provider = {
  name: 'Agent Data Proxy',
  base_url: 'http://127.0.0.1:8787/v1',
  requires_openai_auth: 'true',
  wire_api: '"responses"',
  supports_websockets: 'false'
};

function setKey(lines, key, value, start, end) {
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=`);
  for (let index = start; index < end; index += 1) {
    if (pattern.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return;
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
}

function configure(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable < 0) firstTable = lines.length;
  setKey(lines, 'model_provider', '"agent_data_proxy"', 0, firstTable);

  let section = lines.findIndex((line) => /^\s*\[model_providers\.agent_data_proxy\]\s*$/.test(line));
  if (section < 0) {
    if (lines.length && lines.at(-1).trim()) lines.push('');
    lines.push('# Managed by Agent Session Data Factory');
    lines.push('[model_providers.agent_data_proxy]');
    lines.push(`name = "${provider.name}"`);
    lines.push(`base_url = "${provider.base_url}"`);
    lines.push(`requires_openai_auth = ${provider.requires_openai_auth}`);
    lines.push(`wire_api = ${provider.wire_api}`);
    lines.push(`supports_websockets = ${provider.supports_websockets}`);
  } else {
    let end = lines.length;
    for (let index = section + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index])) { end = index; break; }
    }
    setKey(lines, 'name', `"${provider.name}"`, section + 1, end);
    end += 1;
    setKey(lines, 'base_url', `"${provider.base_url}"`, section + 1, end);
    end += 1;
    setKey(lines, 'requires_openai_auth', provider.requires_openai_auth, section + 1, end);
    end += 1;
    setKey(lines, 'wire_api', provider.wire_api, section + 1, end);
    end += 1;
    setKey(lines, 'supports_websockets', provider.supports_websockets, section + 1, end);
    for (let index = end - 1; index > section; index -= 1) {
      if (/^\s*env_key\s*=/.test(lines[index])) lines.splice(index, 1);
    }
  }
  return `${lines.join('\n')}\n`;
}

fs.mkdirSync(path.dirname(file), { recursive: true });
const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
fs.writeFileSync(file, configure(original), { mode: 0o600 });
process.stdout.write(`${file}\n`);
