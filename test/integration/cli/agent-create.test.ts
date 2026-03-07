/**
 * Integration tests for the new `agentw agent create` command.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI_ENTRY = path.resolve(__dirname, '../../../src/cli/index.ts');
const TSX_CLI = path.resolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs');
const TEST_PASS = 'test-agent-password-123';

function cliSync(args: string[], cwd: string, extra: Record<string, string> = {}) {
    return spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NO_COLOR: '1',
            CI: '1',
            ...extra,
        },
        cwd,
    });
}

describe('agentw agent create — integration', () => {
    let tmpDir: string;
    let configPath: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molthold-agent-create-test-'));
        configPath = path.join(tmpDir, 'agents.json');
        // Start with an empty config
        fs.writeFileSync(configPath, '[]', 'utf8');
    });

    afterAll(() => {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates a new agent and updates the config file', () => {
        const agentName = 'test-create-agent';
        const result = cliSync(['agent', 'create', '--name', agentName, '--password', TEST_PASS, '--config', configPath], tmpDir);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Creating Agent: ${agentName}`);
        expect(result.stdout).toContain(`Keystore saved to`);
        expect(result.stdout).toContain(`Added agent "${agentName}" to`);

        // Verify keystore exists
        const kpPath = path.join(tmpDir, 'keystores', `${agentName}.keystore.json`);
        expect(fs.existsSync(kpPath)).toBe(true);

        // Verify config was updated
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(config).toHaveLength(1);
        expect(config[0].id).toBe(agentName);
        expect(config[0].keystorePath).toBe(`keystores/${agentName}.keystore.json`);
    });

    it('prevents creating an agent with an existing name (keystore conflict)', () => {
        const agentName = 'duplicate-agent';
        // Create first one
        cliSync(['agent', 'create', '--name', agentName, '--password', TEST_PASS, '--config', configPath], tmpDir);

        // Try again
        const result = cliSync(['agent', 'create', '--name', agentName, '--password', TEST_PASS, '--config', configPath], tmpDir);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Keystore for agent "${agentName}" already exists`);
    });

    it('rejects invalid agent names', () => {
        const result = cliSync(['agent', 'create', '--name', 'invalid name!', '--password', TEST_PASS, '--config', configPath], tmpDir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Agent name may only contain letters, numbers, hyphens, and underscores');
    });
});
