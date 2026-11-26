const { closeSync, mkdirSync, openSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const source = process.argv[2];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!uuid.test(source ?? '')) {
  process.exitCode = 1;
} else {
  const directory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'peakusage', 'claims');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    closeSync(openSync(join(directory, source.toLowerCase()), 'wx', 0o600));
  } catch (error) {
    process.exitCode = error.code === 'EEXIST' ? 2 : 1;
  }
}
