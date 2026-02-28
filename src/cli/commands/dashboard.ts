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

        const configs = loadAgentConfigs(opts.config);
        if (configs.length === 0) {
            logger.error('No agents found in configuration file');
            process.exit(1);
        }

        const manager = new MultiAgentManager(configs, logger, rpcUrl, auditDbPath);

        logger.info(`Starting Dashboard Server observing ${configs.length} agents... (Run 'agentw agent start' separately to boot execution loops!)`);

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
                const states = manager.getAgentStates();
                // Convert to the exact `AGENTS` map format expected by the frontend
                const agentMap: Record<string, any> = {};

                for (const config of configs) {
                    // Skip agents whose keystore has been deleted
                    if (!fs.existsSync(config.keystorePath)) {
                        continue;
                    }

                    const state = states.find(s => s.agentId === config.id);

                    // Count errors by doing a quick group query on the DB
                    let errorCount = 0;
                    try {
                        const auditDb = manager.getAuditDb();
                        const errors = auditDb.query({ agentId: config.id, event: 'agent_error', limit: 1000 });
                        errorCount = errors.length;
                    } catch (e) {
                        // Ignore if db is locked
                    }

                    let swapCount = 0;
                    let lpCount = 0;
                    let latestSolBalance = 0;
                    let latestPubkey = 'Unknown';
                    let latestTick = 0;
                    let latestStrategy = config.strategy.toUpperCase();
                    let isHeartbeatRunning = false;

                    try {
                        const auditDb = manager.getAuditDb();

                        // 1. Calculate counts
                        const swaps = auditDb.query({ agentId: config.id, event: 'tx_attempt', limit: 1000 });
                        const successes = auditDb.query({ agentId: config.id, event: 'tx_confirmed', limit: 1000 });
                        for (const row of successes) {
                            if (row.details_json.includes('"provide_liquidity"')) lpCount++;
                        }
                        swapCount = swaps.length;

                        // 2. Fetch latest state from DB (Persistence)
                        // Look back up to 50 rows to find a valid SOL balance (events like start/stop/error don't always have it)
                        const recentRows = auditDb.query({ agentId: config.id, limit: 50 });
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
                            latestStrategy = details.strategy ? String(details.strategy).toUpperCase() : config.strategy.toUpperCase();

                            // 3. Heartbeat detection (Decoupled execution)
                            // If the latest event is 'agent_stop', it is definitely NOT running
                            if (latestRow.event !== 'agent_stop') {
                                const rowTime = new Date(latestRow.ts).getTime();
                                const now = Date.now();
                                // Responsive Heartbeat: 2.5x the agent interval, min 30s
                                const threshold = Math.max(30_000, config.intervalMs * 2.5);
                                if ((now - rowTime) < threshold) {
                                    isHeartbeatRunning = true;
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore if db is locked
                    }

                    const isRunning = (state !== undefined) || isHeartbeatRunning;

                    agentMap[config.id] = {
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
                // Return 100 most recent events across all agents
                try {
                    const auditDb = manager.getAuditDb();
                    const rows = auditDb.query({ limit: 100 });

                    // Group by agent ID as expected by `allEvents`
                    const states = manager.getAgentStates();
                    const eventsMap: Record<string, any[]> = {};
                    const tickHistoryMap: Record<string, string[]> = {};
                    let totalEvents = 0;

                    for (const config of configs) {
                        if (!fs.existsSync(config.keystorePath)) {
                            continue;
                        }
                        eventsMap[config.id] = [];
                        tickHistoryMap[config.id] = Array(12).fill('noop');
                    }

                    for (const row of rows) {
                        // FIX: Detect heartbeat to decide if agent is "active" for this UI session
                        const latestForAgent = auditDb.query({ agentId: row.agent_id, limit: 1 })[0];
                        const agentIsRunningLocally = states.some(s => s.agentId === row.agent_id);

                        let heartbeatActive = false;
                        if (latestForAgent) {
                            const lastActionTime = new Date(latestForAgent.ts).getTime();
                            if ((Date.now() - lastActionTime) < 300_000) heartbeatActive = true;
                        }

                        if (!agentIsRunningLocally && !heartbeatActive) continue;

                        if (!eventsMap[row.agent_id]) {
                            eventsMap[row.agent_id] = [];
                            tickHistoryMap[row.agent_id] = Array(12).fill('noop');
                        }

                        let details: any = {};
                        try {
                            details = JSON.parse(row.details_json);
                        } catch (e) {
                            // ignore parse errors
                        }

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

                        eventsMap[row.agent_id]!.push(evt);

                        tickHistoryMap[row.agent_id] = [...tickHistoryMap[row.agent_id]!.slice(1), tagClass];
                        totalEvents++;
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
