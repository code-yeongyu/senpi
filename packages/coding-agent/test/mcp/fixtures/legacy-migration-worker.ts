// Test worker: one McpTokenStore for a given server name reads (adopting the
// URL-keyed legacy record), then reports which refresh token it ended with.
// Spawned by token-store-legacy-migration-lock.test.ts as a separate OS process.
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";

const [agentDir, serverName, serverUrl, mode] = process.argv.slice(2);
const store = new McpTokenStore({ agentDir, serverName, serverUrl, lock: { retries: 50, stale: 30_000 } });
const record = mode === "async" ? await store.readAsync() : store.read();
process.stdout.write(`${JSON.stringify({ serverName, refresh: record?.refreshToken ?? null })}\n`);
