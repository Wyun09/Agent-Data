#!/usr/bin/env node
require('../../../scripts/bootstrap-packages')();
require('../index').main().catch((error) => {
  process.stderr.write(`agent-data: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
