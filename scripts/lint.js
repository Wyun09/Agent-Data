const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git']);
let failures = 0;

function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && file.endsWith('.js')) {
      try {
        require('node:child_process').execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (error) {
        failures += 1;
        process.stderr.write(`${file}: ${error.stderr?.toString() || error.message}\n`);
      }
    }
  }
}

visit(root);
if (failures) process.exitCode = 1;
