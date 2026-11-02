import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readModelDataStructure } from "../scripts/model-data.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * models.dev can stop describing a provider the fork still ships. The prune keeps that provider's
 * shard because its module imports it, and the freshly written aggregator no longer mentions it -
 * which must not read as a corrupt catalog, or the release dies before it can publish.
 */
describe("readModelDataStructure with a shard the aggregator no longer lists", () => {
	function stageCatalog(): string {
		const root = mkdtempSync(join(tmpdir(), "dh-model-data-"));
		roots.push(root);
		cpSync(join(packageRoot, "src"), join(root, "src"), { recursive: true });
		return root;
	}

	/**
	 * Picked from the staged catalog rather than named, so a provider changing hands - as
	 * `kimi-coding` did when it became fork-owned - retargets this test instead of breaking it.
	 */
	function anImportedGeneratedShard(root: string, aggregator: string): string {
		const providersDir = join(root, "src", "providers");
		for (const entry of readdirSync(providersDir)) {
			if (!entry.endsWith(".models.ts")) continue;
			if (!aggregator.includes(entry)) continue;
			const modulePath = join(providersDir, `${entry.slice(0, -".models.ts".length)}.ts`);
			let module: string;
			try {
				module = readFileSync(modulePath, "utf8");
			} catch {
				continue;
			}
			if (module.includes(`./${entry}`)) return entry;
		}
		throw new Error("no generated shard is imported by its provider module");
	}

	it("accepts a shard whose provider module imports it", () => {
		const root = stageCatalog();
		const aggregatorPath = join(root, "src", "models.generated.ts");
		const aggregator = readFileSync(aggregatorPath, "utf8");
		const shard = anImportedGeneratedShard(root, aggregator);
		const constName = `${shard
			.slice(0, -".models.ts".length)
			.toUpperCase()
			.replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
		const dropped = aggregator
			.split("\n")
			.filter((line) => !line.includes(shard) && !line.includes(constName))
			.join("\n");
		expect(dropped).not.toBe(aggregator);
		writeFileSync(aggregatorPath, dropped);

		expect(() => readModelDataStructure(root)).not.toThrow();
	});
});
