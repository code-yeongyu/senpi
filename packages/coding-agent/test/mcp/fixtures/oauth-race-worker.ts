// Test worker for the refresh-race proof. Two of these run as separate OS
// processes against one shared token store + one fixture IdP. A file barrier
// releases both at once so a concurrent refresh is forced.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";

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

	const first = await refreshAttempt(manager);
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
	const postRace = await refreshAttempt(manager);
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

async function refreshAttempt(manager: McpRefreshManager): Promise<{
	ok: boolean;
	refreshHash?: string;
	kind?: string;
}> {
	try {
		const tokens = await manager.refresh();
		const refreshHash = tokens.refresh_token === undefined ? undefined : tokenFingerprint(tokens.refresh_token);
		return { ok: true, refreshHash };
	} catch (error) {
		const kind = (error as { oauthKind?: string }).oauthKind ?? "error";
		return { ok: false, kind };
	}
}

function tokenFingerprint(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
