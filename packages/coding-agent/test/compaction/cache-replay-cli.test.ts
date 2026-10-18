import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { syntheticCacheSession } from "../support/cache-replay-fixture.ts";
import type { replayContextCache } from "../support/cache-replay-model.ts";

it("compares statically loaded engines using the identical in-memory snapshot", async () => {
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	const cli = fileURLToPath(new URL("../support/replay-context-cache.ts", import.meta.url));
	const input = syntheticCacheSession()
		.slice(0, 5)
		.map((entry) => JSON.stringify(entry))
		.join("\n");
	const agentDir = process.env.SENPI_CODING_AGENT_DIR;
	if (!agentDir) throw new Error("Missing test quarantine");
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = execFile(
			"bun",
			[cli, "--stdin", "--compare-repo", root],
			{
				cwd: root,
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir },
			},
			(error, output) => (error ? reject(error) : resolve(output)),
		);
		child.stdin?.end(input);
	});
	const result: { baseline: ReturnType<typeof replayContextCache>; branch: ReturnType<typeof replayContextCache> } =
		JSON.parse(stdout);
	expect(result.branch.requests).toBe(2);
	expect(result.baseline).toEqual(result.branch);
	expect(result.branch.blockBudgetPercent).toBe(10);
}, 60_000);
