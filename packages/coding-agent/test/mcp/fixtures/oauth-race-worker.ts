// Test worker for the refresh-race proof. Two of these run as separate OS
// processes against one shared token store + one fixture IdP. A file barrier
// releases both at once so a concurrent refresh is forced.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import type { McpServerConfig } from "../../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";
import type { McpConnectionEntry } from "../../../src/core/extensions/builtin/mcp/service-types.ts";
import { connectAndRefreshMcpCatalog } from "../../../src/core/extensions/builtin/mcp/startup-race.ts";

async function main(): Promise<void> {
	const [agentDir, mcpUrl, barrierFile, tag, disableLock] = process.argv.slice(2);
	const lockDisabled = disableLock === "1";
	const store = new McpTokenStore({
		agentDir,
		serverName: "race",
		serverUrl: mcpUrl ?? "",
		disableLock: lockDisabled,
	});
	const provider = new McpOAuthProvider({
		serverName: "race",
		serverUrl: mcpUrl ?? "",
		store,
		clientId: "race-client",
	});

	// Two-phase file barrier so both worker processes fire their refresh within the
	// same scheduling window even on a busy host — otherwise the concurrent-refresh
	// race the control case proves (and the contention the lock-ON case relies on)
	// does not reliably reproduce. Phase 1: wait for both processes to arrive.
	// Phase 2: both signal ready and busy-wait on a 1ms poll so the two attempts are
	// released together, replacing a fixed 20ms sleep that left them skewed under load.
	appendFileSync(barrierFile ?? "", `${tag}\n`);
	for (let i = 0; i < 400; i++) {
		if (
			readFileSync(barrierFile ?? "", "utf8")
				.split("\n")
				.filter((line) => line.length > 0 && !line.includes(":")).length >= 2
		)
			break;
		await sleep(5);
	}
	appendFileSync(barrierFile ?? "", `${tag}:ready\n`);
	for (let i = 0; i < 400; i++) {
		if (
			readFileSync(barrierFile ?? "", "utf8")
				.split("\n")
				.filter((line) => line.endsWith(":ready")).length >= 2
		)
			break;
		await sleep(1);
	}

	const first = await runtimeAttempt(agentDir ?? "", mcpUrl ?? "", provider, store);
	if (!lockDisabled) {
		process.stdout.write(`${JSON.stringify({ tag, ...first })}\n`);
		return;
	}

	appendFileSync(barrierFile ?? "", `${tag}:after\n`);
	for (let i = 0; i < 200; i++) {
		if (
			readFileSync(barrierFile ?? "", "utf8")
				.trim()
				.split("\n")
				.filter((line) => line.endsWith(":after")).length >= 2
		)
			break;
		await sleep(10);
	}
	await sleep(20);
	await store.update((current) =>
		current === undefined ? undefined : { ...current, expiresAt: Date.now() + 60_000 },
	);
	const postRace = await runtimeAttempt(agentDir ?? "", mcpUrl ?? "", provider, store);
	process.stdout.write(
		`${JSON.stringify({
			tag,
			...first,
			postRaceOk: postRace.ok,
			postRaceKind: postRace.kind,
			postRaceRefreshHash: postRace.refreshHash,
		})}\n`,
	);
}

async function runtimeAttempt(
	agentDir: string,
	mcpUrl: string,
	provider: McpOAuthProvider,
	store: McpTokenStore,
): Promise<{
	ok: boolean;
	refreshHash?: string;
	kind?: string;
}> {
	const config: McpServerConfig = {
		args: [],
		connectTimeoutMs: 4000,
		enabled: true,
		exposure: "auto",
		idleTimeoutMin: 10,
		lifecycle: "lazy",
		logLevel: "info",
		requestTimeoutMs: 4000,
		type: "http",
		url: mcpUrl,
	};
	const connection = new ServerConnection({
		authProvider: provider,
		config,
		logger: createMcpLogger(`race-${process.pid}`),
		serverName: "race",
	});
	const entry: McpConnectionEntry = {
		agentDir,
		authPlan: { mode: "oauth", provider, refresh: new McpRefreshManager(provider, { retryDelayMs: 5 }) },
		cacheRefreshedAfterConnect: false,
		configHash: "race-runtime",
		connection,
		counters: { callCount: 0, errorCount: 0, reconnectCount: 0, totalLatencyMs: 0 },
		createdAtMs: Date.now(),
		key: `race\0runtime-${process.pid}`,
		logger: createMcpLogger(`race-entry-${process.pid}`),
		name: "race",
	};
	try {
		await connectAndRefreshMcpCatalog(entry, config);
		if (entry.connection.state !== "connected" || entry.cachedCatalog === undefined) {
			return { ok: false, kind: entry.connection.state };
		}
		const stored = store.read();
		const refreshHash = stored?.refreshToken === undefined ? undefined : tokenFingerprint(stored.refreshToken);
		return { ok: true, refreshHash };
	} catch (error) {
		const kind = oauthKind(error) ?? "error";
		return { ok: false, kind };
	} finally {
		await connection.dispose();
	}
}

function oauthKind(error: unknown, depth = 0): string | undefined {
	if (depth > 5 || typeof error !== "object" || error === null) return undefined;
	const kind = (error as { oauthKind?: unknown }).oauthKind;
	if (typeof kind === "string") return kind;
	return oauthKind((error as { cause?: unknown }).cause, depth + 1);
}

function tokenFingerprint(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
