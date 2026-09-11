import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORK_OWNED_MODEL_SHARDS, isPrunableModelShard, MODEL_SHARD_SUFFIX } from "../scripts/model-shards.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const providersDir = join(packageRoot, "src/providers");

function generatedShardNames(): Set<string> {
	const aggregator = readFileSync(join(packageRoot, "src/models.generated.ts"), "utf8");
	const names = new Set<string>();
	for (const match of aggregator.matchAll(/from "\.\/providers\/([^"]+\.models\.ts)"/g)) {
		const [, shard] = match;
		if (shard !== undefined) names.add(shard);
	}
	return names;
}

function importedShardNames(): Set<string> {
	const names = new Set<string>();
	for (const entry of readdirSync(providersDir)) {
		if (!entry.endsWith(".ts") || entry.endsWith(MODEL_SHARD_SUFFIX)) continue;
		const source = readFileSync(join(providersDir, entry), "utf8");
		for (const match of source.matchAll(/from "\.\/([^"]+\.models\.ts)"/g)) {
			const [, shard] = match;
			if (shard !== undefined) names.add(shard);
		}
	}
	return names;
}

describe("model catalog shard ownership", () => {
	it("declares every shard a provider imports that the generator does not write", () => {
		const generated = generatedShardNames();
		expect(generated.size).toBeGreaterThan(0);
		const handOwned = [...importedShardNames()].filter((shard) => !generated.has(shard)).sort();
		expect(handOwned).toEqual([...FORK_OWNED_MODEL_SHARDS].sort());
	});

	it("prunes a shard the run did not write and the fork does not own", () => {
		expect(isPrunableModelShard("retired-provider.models.ts", new Set(["anthropic.models.ts"]))).toBe(true);
	});

	it("keeps a shard the current run wrote", () => {
		expect(isPrunableModelShard("anthropic.models.ts", new Set(["anthropic.models.ts"]))).toBe(false);
	});

	it("keeps every fork-owned shard the generator never writes", () => {
		for (const shard of FORK_OWNED_MODEL_SHARDS) {
			expect(isPrunableModelShard(shard, new Set(["anthropic.models.ts"]))).toBe(false);
		}
	});

	it("ignores files that are not catalog shards", () => {
		expect(isPrunableModelShard("devin.ts", new Set())).toBe(false);
	});
});
