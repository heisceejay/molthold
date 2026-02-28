/**
 * @file src/cli/commands/dashboard.ts
 *
 * Starts a native HTTP server serving a single-page HTML dashboard
 * connected to the live agent framework endpoints.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { createLogger } from '../../logger/index.js';
import { MultiAgentManager, loadAgentConfigs } from '../../agent/manager.js';
import { getPublicKeyFromKeystore } from '../../wallet/keystore.js';
import type { AgentLoopState } from '../../agent/types.js';

export const dashboardCommand = new Command('dashboard')
    .description('Start the local HTTP dashboard and multi-agent manager')
    .requiredOption('-c, --config <path>', 'Path to agents.json configuration file')
    .option('-p, --port <number>', 'HTTP server port', '3000')
    .action(async (opts: { config: string; port: string }) => {
        const logger = createLogger({ level: process.env['LOG_LEVEL'] ?? 'info' });
        const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
        const auditDbPath = process.env['AUDIT_DB_PATH'] ?? './logs/audit.db';
        const port = parseInt(opts.port, 10);

        const manager = new MultiAgentManager([], logger, rpcUrl, auditDbPath);

        logger.info(`Starting Dashboard Server... (Run 'agentw agent start' separately to boot execution loops!)`);

        // Setup graceful shutdown
        let isShuttingDown = false;
        const shutdown = async (signal?: string) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            logger.info(`\nShutting down server and agents... (Signal: ${signal || 'N/A'})`);
            server.close();
            await manager.stop();
            process.exit(0);
        };

        process.on('SIGINT', () => { void shutdown('SIGINT'); });
        process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

        // Mount HTTP Server
        const server = http.createServer((req, res) => {
            // CORS for local development
            res.setHeader('Access-Control-Allow-Origin', '*');

            if (req.method === 'GET' && req.url === '/') {
                // Serve the dashboard HTML file
                const htmlPath = path.resolve(process.env['DASHBOARD_HTML_PATH'] ?? path.join(process.cwd(), 'public', 'index.html'));
                fs.readFile(htmlPath, 'utf8', (err, data) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end(`Error loading dashboard HTML from ${htmlPath}: ${err.message}`);
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(data);
                });
                return;
            }

            if (req.method === 'GET' && req.url === '/api/agents') {
                const configs = loadAgentConfigs(opts.config);
                const states = manager.getAgentStates();
                const auditDb = manager.getAuditDb();

                // 1. Discovery phase: collect unique IDs from all sources
                const allAgentIds = new Set<string>();
                configs.forEach(c => allAgentIds.add(c.id));
                states.forEach(s => allAgentIds.add(s.agentId));
                try {
                    const historical = auditDb.summarise();
                    historical.forEach(h => allAgentIds.add(h.agent_id));
                } catch (e) { }

                // Also scan keystores directory
                const keystoresDir = path.resolve(process.cwd(), 'keystores');
                if (fs.existsSync(keystoresDir)) {
                    fs.readdirSync(keystoresDir).forEach(f => {
                        if (f.endsWith('.keystore.json')) {
                            allAgentIds.add(f.replace('.keystore.json', ''));
                        }
                    });
                }

                const agentMap: Record<string, any> = {};

                for (const agentId of allAgentIds) {
                    const config = configs.find(c => c.id === agentId);
                    const state = states.find(s => s.agentId === agentId);
                    const ksPathRelative = config?.keystorePath || path.join('keystores', `${agentId}.keystore.json`);
                    const ksPathAbsolute = path.resolve(process.cwd(), ksPathRelative);

                    // STRICT VISIBILITY: If the keystore is gone, the agent is gone.
                    if (!fs.existsSync(ksPathAbsolute)) {
                        continue;
                    }

                    // IDENTITY: The wallet public key defines the "session" for this agent ID.
                    let currentPubkey = 'Unknown';
                    try {
                        currentPubkey = getPublicKeyFromKeystore(ksPathAbsolute);
                    } catch (e) { /* ignore corrupt keystore */ }

                    // Count errors by doing a quick group query on the DB
                    let errorCount = 0;
                    try {
                        const errors = auditDb.query({
                            agentId: agentId,
                            walletPk: currentPubkey,
                            event: 'agent_error',
                            limit: 1000
                        });
                        errorCount = errors.length;
                    } catch (e) { }

                    let swapCount = 0;
                    let lpCount = 0;
                    let latestSolBalance = 0;
                    let latestPubkey = currentPubkey;
                    let latestTick = 0;
                    let latestStrategy = config?.strategy.toUpperCase() ?? 'UNKNOWN';
                    let isHeartbeatRunning = false;

                    try {
                        // 1. Calculate counts
                        const swaps = auditDb.query({
                            agentId: agentId,
                            walletPk: currentPubkey,
                            event: 'tx_attempt',
                            limit: 1000
                        });
                        const successes = auditDb.query({
                            agentId: agentId,
                            walletPk: currentPubkey,
                            event: 'tx_confirmed',
                            limit: 1000
                        });
                        for (const row of successes) {
                            if (row.details_json.includes('"provide_liquidity"')) lpCount++;
                        }
                        swapCount = swaps.length;

                        // 2. Fetch latest state from DB (Persistence)
                        const recentRows = auditDb.query({
                            agentId: agentId,
                            walletPk: currentPubkey,
                            limit: 50
                        });
                        const latestRow = recentRows[0];

                        if (latestRow) {
                            latestPubkey = latestRow.wallet_pk || 'Unknown';
                            const firstWithBalance = recentRows.find(r => {
                                try {
                                    const d = JSON.parse(r.details_json);
                                    return d.solBalance !== undefined && d.solBalance !== null;
                                } catch { return false; }
                            });

                            if (firstWithBalance) {
                                const details = JSON.parse(firstWithBalance.details_json);
                                latestSolBalance = Number(BigInt(details.solBalance)) / 1_000_000_000;
                            }

                            const details = JSON.parse(latestRow.details_json);
                            latestTick = details.tickCount ?? 0;
                            latestStrategy = details.strategy ? String(details.strategy).toUpperCase() : (config?.strategy.toUpperCase() ?? 'UNKNOWN');

                            if (latestRow.event !== 'agent_stop') {
                                const rowTime = new Date(latestRow.ts).getTime();
                                const now = Date.now();
                                const interval = config?.intervalMs ?? 30000;
                                const threshold = Math.max(30_000, interval * 2.5);
                                if ((now - rowTime) < threshold) {
                                    isHeartbeatRunning = true;
                                }
                            }
                        }
                    } catch (e) { }

                    const isRunning = (state !== undefined) || isHeartbeatRunning;

                    agentMap[agentId] = {
                        strategy: state?.strategy.toUpperCase() ?? latestStrategy,
                        ticks: isRunning ? (state?.tickCount ?? latestTick) : 0,
                        swaps: isRunning ? swapCount : 0,
                        lps: isRunning ? lpCount : 0,
                        noops: isRunning ? (state?.tickCount ?? latestTick) : 0,
                        errors: isRunning ? errorCount : 0,
                        sessionSol: 0,
                        balance: latestSolBalance,
                        pubkey: state?.walletPubkey ?? latestPubkey,
                        status: isRunning ? 'running' : 'stopped'
                    };
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(agentMap));
                return;
            }

            if (req.method === 'GET' && req.url === '/api/events') {
                const configs = loadAgentConfigs(opts.config);
                // Return 100 most recent events across all agents
                try {
                    const auditDb = manager.getAuditDb();

                    const states = manager.getAgentStates() as AgentLoopState[];
                    const keystoresDir = path.resolve(process.cwd(), 'keystores');

                    // Group by agent ID as expected by `allEvents`
                    // Discovery phase: collect unique IDs from all sources for event mapping
                    const allAgentIds = new Set<string>();
                    configs.forEach(c => allAgentIds.add(c.id));
                    states.forEach(s => allAgentIds.add(s.agentId));
                    try {
                        const historical = auditDb.summarise();
                        historical.forEach(h => allAgentIds.add(h.agent_id));
                    } catch (e) { }

                    // Also scan keystores
                    if (fs.existsSync(keystoresDir)) {
                        fs.readdirSync(keystoresDir).forEach(f => {
                            if (f.endsWith('.keystore.json')) {
                                allAgentIds.add(f.replace('.keystore.json', ''));
                            }
                        });
                    }

                    const eventsMap: Record<string, any[]> = {};
                    const tickHistoryMap: Record<string, string[]> = {};
                    let totalEvents = 0;

                    for (const agentId of allAgentIds) {
                        const config = configs.find(c => c.id === agentId);
                        const ksPathRelative = config?.keystorePath || path.join('keystores', `${agentId}.keystore.json`);
                        const ksPathAbsolute = path.resolve(process.cwd(), ksPathRelative);

                        // STRICT VISIBILITY: If the keystore is gone, the agent is gone.
                        if (!fs.existsSync(ksPathAbsolute)) {
                            continue;
                        }

                        let currentPubkey = '';
                        try {
                            currentPubkey = getPublicKeyFromKeystore(ksPathAbsolute);
                        } catch (e) { continue; }

                        eventsMap[agentId] = [];
                        tickHistoryMap[agentId] = Array(12).fill('noop');

                        // IDENTITY: Filter events specifically for this wallet
                        const agentRows = auditDb.query({
                            agentId: agentId,
                            walletPk: currentPubkey,
                            limit: 50
                        });

                        for (const row of agentRows) {
                            let details: any = {};
                            try {
                                details = JSON.parse(row.details_json);
                            } catch (e) { }

                            const isLP = details.action === 'provide_liquidity' || row.event.includes('lp');
                            const isSwap = details.action === 'swap' || row.event.includes('swap') || row.event === 'tx_attempt' || row.event === 'tx_confirmed';

                            let tagClass = 'noop';
                            if (row.event.includes('error') || row.event.includes('fail') || row.event === 'limit_breach') {
                                tagClass = 'error';
                            } else if (row.event === 'tx_confirmed' || row.event === 'agent_action') {
                                tagClass = isLP ? 'provide_liquidity' : 'confirmed';
                            } else if (row.event === 'tx_attempt' || isSwap) {
                                tagClass = isLP ? 'provide_liquidity' : 'swap';
                            }

                            const evt = {
                                id: `${row.ts}-${row.agent_id}-${row.signature || 'no-sig'}`,
                                tick: details.tickCount ?? 0,
                                type: row.event,
                                tagClass,
                                label: row.event.toUpperCase(),
                                main: details.message ?? row.event,
                                meta: row.signature ? `sig: ${row.signature.slice(0, 16)}…` : '',
                                ts: new Date(row.ts).getTime(),
                                agentId: row.agent_id,
                                isNew: false
                            };

                            eventsMap[agentId]!.push(evt);
                            tickHistoryMap[agentId] = [...tickHistoryMap[agentId]!.slice(1), tagClass];
                            totalEvents++;
                        }
                    }

                    // Ensure events are strictly sorted descending by timestamp before reaching the UI mapping loop
                    for (const agentId of Object.keys(eventsMap)) {
                        const agentEvents = eventsMap[agentId];
                        if (agentEvents) {
                            agentEvents.sort((a, b) => b.ts - a.ts);
                        }
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        events: eventsMap,
                        tickHistory: tickHistoryMap,
                        totalEvents
                    }));

                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(e) }));
                }
                return;
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found\n');
        });

        server.listen(port, '0.0.0.0', () => {
            logger.info(`Dashboard running at http://localhost:${port}/`);
        });
    });
