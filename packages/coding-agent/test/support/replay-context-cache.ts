/** Offline replay CLI. Copy this file, cache-replay-model.ts, and cache-replay-fixture.ts
 * to the baseline checkout when using --compare-repo. Both processes receive one
 * in-memory JSONL snapshot; only aggregate JSON is printed. No provider calls. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { text } from "node:stream/consumers";
import { pathToFileURL } from "node:url";
import { parseSessionEntries } from "../../src/core/session-manager.ts";
import { syntheticCacheSession } from "./cache-replay-fixture.ts";
import { replayContextCache } from "./cache-replay-model.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const value = (name: string) => args[args.indexOf(name) + 1];
	const synthetic = args.includes("--synthetic");
	const session = args.includes("--session") ? value("--session") : undefined;
	if (!synthetic && !session && !args.includes("--stdin")) throw new Error("Use --synthetic or --session <JSONL>.");
	const entries = synthetic
		? syntheticCacheSession()
		: parseSessionEntries(args.includes("--stdin") ? await text(process.stdin) : readFileSync(session ?? "", "utf8"));
	const options = {
		contextWindow: args.includes("--window") ? Number(value("--window")) : 1_000_000,
		fixedPrefixTokens: args.includes("--fixed-prefix-tokens") ? Number(value("--fixed-prefix-tokens")) : 52_600,
		feedback: synthetic || args.includes("--feedback"),
	};
	const budgets = args.includes("--block-budget-percent")
		? value("--block-budget-percent").split(",").map(Number)
		: [10];
	if (budgets.some((budget) => !Number.isFinite(budget) || budget <= 0 || budget > 100)) {
		throw new Error("--block-budget-percent must contain percentages greater than 0 and at most 100.");
	}
	let baselineResults: unknown[] | undefined;
	if (args.includes("--compare-repo")) {
		const root = resolve(value("--compare-repo"));
		const child = spawn(
			process.execPath,
			[
				resolve(root, "packages/coding-agent/test/support/replay-context-cache.ts"),
				"--stdin",
				"--window",
				String(options.contextWindow),
				"--fixed-prefix-tokens",
				String(options.fixedPrefixTokens),
				"--block-budget-percent",
				budgets.join(","),
				...(options.feedback ? ["--feedback"] : []),
			],
			{
				cwd: root,
				stdio: "pipe",
			},
		);
		const exited = new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? 1));
		});
		const output = Promise.all([text(child.stdout), text(child.stderr), exited]);
		child.stdin.end(entries.map((entry) => JSON.stringify(entry)).join("\n"));
		const [stdout, stderr, exit] = await output;
		if (exit !== 0) throw new Error(`Baseline replay failed (${exit}): ${stderr}`);
		const parsed: unknown = JSON.parse(stdout);
		baselineResults = Array.isArray(parsed) ? parsed : [parsed];
		if (baselineResults.length !== budgets.length) throw new Error("Baseline budget count differs.");
	}
	const results = budgets.map((budget, index) => {
		const branch = replayContextCache(entries, { ...options, blockBudgetRatio: budget / 100 });
		return baselineResults ? { baseline: baselineResults[index], branch } : branch;
	});
	console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}
