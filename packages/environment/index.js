const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function commandText(command, args = [], options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: options.timeoutMs || 3000,
      windowsHide: true
    }).trim();
  } catch {
    return null;
  }
}

function gitMetadata(cwd) {
  const root = commandText('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (!root) return { root: null, head: null, branch: null, dirty: null, changed_files: null };
  const status = commandText('git', ['status', '--porcelain=v1'], { cwd }) || '';
  return {
    root,
    head: commandText('git', ['rev-parse', 'HEAD'], { cwd: root }),
    branch: commandText('git', ['branch', '--show-current'], { cwd: root }) || null,
    dirty: status.length > 0,
    changed_files: status ? status.split(/\r?\n/).filter(Boolean).length : 0
  };
}

function executableMetadata(command, cwd) {
  const executable = commandText(process.platform === 'win32' ? 'where' : 'which', [command], { cwd });
  const version = executable ? commandText(command, ['--version'], { cwd }) : null;
  return { command, executable, version: version ? version.slice(0, 500) : null };
}

function captureEnvironment(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const command = Array.isArray(options.command) ? options.command[0] : options.command;
  return {
    captured_at: new Date().toISOString(),
    cwd,
    platform: process.platform,
    architecture: process.arch,
    hostname: options.include_hostname ? os.hostname() : null,
    node: process.versions.node,
    runtime: process.release?.name || 'node',
    git: gitMetadata(cwd),
    agent: command ? executableMetadata(command, cwd) : null
  };
}

function runCommand(command, args = [], options = {}) {
  if (!command) throw new TypeError('command is required');
  const cwd = path.resolve(options.cwd || process.cwd());
  const maxOutputBytes = options.maxOutputBytes || 64 * 1024;
  const startedAt = new Date();
  const result = spawnSync(command, args, {
    cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 0,
    maxBuffer: maxOutputBytes,
    shell: false,
    windowsHide: true
  });
  const endedAt = new Date();
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    command: [command, ...args],
    cwd,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt - startedAt,
    exit_code: timedOut ? null : result.status,
    signal: result.signal || (timedOut ? 'SIGTERM' : null),
    timed_out: timedOut,
    success: !result.error && result.status === 0,
    stdout,
    stderr,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    environment: captureEnvironment({ cwd, command })
  };
}

module.exports = { commandText, gitMetadata, executableMetadata, captureEnvironment, runCommand };
