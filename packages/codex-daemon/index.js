const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

function resolveCodexHome(input) {
  return path.resolve(input || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

function daemonPaths(codexHome) {
  const home = resolveCodexHome(codexHome);
  const controlDir = path.join(home, 'app-server-control');
  return {
    codex_home: home,
    control_dir: controlDir,
    socket: path.join(controlDir, 'app-server-control.sock'),
    startup_lock: path.join(controlDir, 'app-server-startup.lock')
  };
}

async function fileInfo(file) {
  try {
    const lstat = await fsp.lstat(file);
    let target = null;
    let targetExists = false;
    try {
      target = await fsp.realpath(file);
      await fsp.stat(file);
      targetExists = true;
    } catch {
      // A broken symlink is the common stale-socket case.
    }
    return { path: file, exists: true, type: lstat.isSymbolicLink() ? 'symlink' : lstat.isSocket() ? 'socket' : 'file', target, target_exists: targetExists, mtime_ms: lstat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: file, exists: false, target_exists: false, mtime_ms: null };
    throw error;
  }
}

function probeUnixSocket(socket, timeoutMs = 250) {
  return new Promise((resolve) => {
    const connection = net.createConnection({ path: socket });
    let settled = false;
    const done = (alive) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      resolve(alive);
    };
    connection.once('connect', () => done(true));
    connection.once('error', () => done(false));
    connection.setTimeout(timeoutMs, () => done(false));
  });
}

async function inspectCodexDaemon(options = {}) {
  const paths = daemonPaths(options.codexHome);
  const [socket, startupLock] = await Promise.all([fileInfo(paths.socket), fileInfo(paths.startup_lock)]);
  const alive = socket.exists ? await probeUnixSocket(paths.socket, options.timeoutMs || 250) : false;
  const lockAgeMs = startupLock.mtime_ms === null ? null : Math.max(0, Date.now() - startupLock.mtime_ms);
  return {
    ...paths,
    socket,
    startup_lock: { ...startupLock, age_ms: lockAgeMs },
    daemon_alive: alive,
    stale_socket: socket.exists && !alive,
    stale_lock: startupLock.exists && !alive && lockAgeMs !== null && lockAgeMs >= (options.staleAfterMs || 10_000)
  };
}

async function resetCodexDaemon(options = {}) {
  const report = await inspectCodexDaemon(options);
  if (report.daemon_alive && !options.force) return { ...report, removed: [], preserved: true, reason: 'daemon_alive' };
  const removed = [];
  if (report.stale_socket || (options.force && report.socket.exists && !report.daemon_alive)) {
    await fsp.unlink(report.socket.path || report.socket).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    removed.push(report.socket);
  }
  const lockCanBeRemoved = report.startup_lock.exists && !report.daemon_alive &&
    (options.force || (report.startup_lock.age_ms !== null && report.startup_lock.age_ms >= (options.staleAfterMs || 10_000)));
  if (lockCanBeRemoved) {
    await fsp.unlink(report.startup_lock.path || report.startup_lock).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    removed.push(report.startup_lock);
  }
  return { ...report, removed, preserved: false, reason: removed.length ? 'stale_entries_removed' : 'nothing_to_reset' };
}

module.exports = { resolveCodexHome, daemonPaths, probeUnixSocket, inspectCodexDaemon, resetCodexDaemon };
