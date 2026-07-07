// Test worker for the refresh-race proof. Two of these run as separate OS
// processes against one shared token store + one fixture IdP. A file barrier
// releases both at once so a concurrent refresh is forced.
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";

async function main(): Promise<void> {
	const [agentDir, mcpUrl, barrierFile, tag, disableLock] = process.argv.slice(2);
	const store = new McpTokenStore({
		agentDir,
		serverName: "race",
		serverUrl: mcpUrl ?? "",
		disableLock: disableLock === "1",
	});
	const provider = new McpOAuthProvider({
		serverName: "race",
		serverUrl: mcpUrl ?? "",
		store,
		clientId: "race-client",
	});
	const manager = new McpRefreshManager(provider, { retryDelayMs: 5 });

	appendFileSync(barrierFile ?? "", `${tag}\n`);
	for (let i = 0; i < 200; i++) {
		if (
			readFileSync(barrierFile ?? "", "utf8")
				.trim()
				.split("\n")
				.filter(Boolean).length >= 2
		)
			break;
		await sleep(10);
	}
	await sleep(20);

	try {
		const tokens = await manager.refresh();
		process.stdout.write(`${JSON.stringify({ tag, ok: true, refresh: tokens.refresh_token })}\n`);
	} catch (error) {
		const kind = (error as { oauthKind?: string }).oauthKind ?? "error";
		process.stdout.write(`${JSON.stringify({ tag, ok: false, kind })}\n`);
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
