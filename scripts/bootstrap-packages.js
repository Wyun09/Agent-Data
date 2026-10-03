const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packagesRoot = path.join(root, 'packages');
const targetRoot = path.join(root, 'node_modules', '@agent-data');

function replacePackage(name) {
  const source = path.join(packagesRoot, name);
  const target = path.join(targetRoot, name);
  fs.mkdirSync(targetRoot, { recursive: true });
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.cpSync(source, target, { recursive: true, force: true });
}

function bootstrap() {
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) replacePackage(entry.name);
  }
}

if (require.main === module) bootstrap();
module.exports = bootstrap;
