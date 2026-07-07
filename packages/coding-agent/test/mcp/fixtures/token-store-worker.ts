// Test worker: hammers a shared McpTokenStore with locked read-modify-writes.
// Spawned by token-store.test.ts as a separate OS process to prove the
// cross-process proper-lockfile RMW has no torn reads and one winner per round.
import { type McpStoredAuth, McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";

interface RaceRecord extends McpStoredAuth {
	winners: Record<string, string>;
	writes: string[];
}

async function main(): Promise<void> {
	const [agentDir, serverUrl, serverName, tag, roundsRaw] = process.argv.slice(2);
	const rounds = Number.parseInt(roundsRaw ?? "50", 10);
	const store = new McpTokenStore<RaceRecord>({
		agentDir,
		serverName: serverName ?? "race",
		serverUrl: serverUrl ?? "https://race.example",
		lock: { retries: 300, stale: 60_000 },
	});
	for (let round = 0; round < rounds; round++) {
		await store.update((current) => {
			const winners = { ...(current?.winners ?? {}) };
			const writes = [...(current?.writes ?? [])];
			const key = String(round);
			if (winners[key] === undefined) winners[key] = tag ?? "?";
			writes.push(tag ?? "?");
			return { winners, writes };
		});
	}
	process.stdout.write(`${JSON.stringify({ done: tag, rounds })}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
