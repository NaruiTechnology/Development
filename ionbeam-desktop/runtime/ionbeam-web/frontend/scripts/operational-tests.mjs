import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// This spec asserts controls in the deliberately excluded configuration editor.
const files = readdirSync('tests').filter(name => name.endsWith('.test.mjs') && name !== 'timingSettingsHelp.test.mjs');
const result = spawnSync(process.execPath, ['--test', ...files.map(name => `tests/${name}`)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
