#!/usr/bin/env node
// senpi#5855: a coding-agent test shard must finish well inside its 25-minute step timeout. When the suite grows
// past the shard count, this step turns that into a named failure with the measured time, long before a shard is
// killed at the timeout with no failing test. The fix is more shards in `.github/workflows/ci.yml`, never a
// larger budget or timeout.
import { pathToFileURL } from "node:url";

/** Seconds a shard job may run, from its first step through its tests. */
export const SHARD_BUDGET_SECONDS = 900;

export function measureShard({ startedAt, now, budgetSeconds = SHARD_BUDGET_SECONDS }) {
	if (!Number.isInteger(startedAt) || startedAt <= 0) throw new Error("SHARD_BUDGET_STARTED must be an epoch second");
	const elapsed = now - startedAt;
	return { elapsed, budgetSeconds, over: elapsed > budgetSeconds };
}

function main() {
	const label = process.env.SHARD_LABEL ?? "coding-agent shard";
	const { elapsed, budgetSeconds, over } = measureShard({
		startedAt: Number(process.env.SHARD_BUDGET_STARTED),
		now: Math.floor(Date.now() / 1000),
	});
	if (over) {
		console.log(
			`::error::${label} ran ${elapsed} s, over its ${budgetSeconds} s budget (senpi#5855). ` +
				"Add shards to the test-coding-agent matrix in .github/workflows/ci.yml; do not raise the budget or timeout.",
		);
		process.exit(1);
	}
	console.log(`${label} ran ${elapsed} s of its ${budgetSeconds} s budget.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
