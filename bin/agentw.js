#!/usr/bin/env node
/**
 * Shim to run the TypeScript CLI directly via tsx without needing a build step.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '../src/cli/index.ts');

const result = spawnSync('npx', ['tsx', entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: true,
});

process.exit(result.status ?? 0);
