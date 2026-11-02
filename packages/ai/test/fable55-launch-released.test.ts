import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FABLE55_LAUNCH, isFable55ModelId } from "../src/utils/fable55-launch.ts";

// senpi#3893: flipping `released` before the regenerated catalog carries the row would silently drop the Fable slot.
const catalogPath = fileURLToPath(new URL("../src/providers/data/anthropic.json", import.meta.url));
type CatalogRow = { id: string; cost?: { input?: number; output?: number } };
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, Record<string, CatalogRow>>;
const anthropicRows = Object.values(catalog).flatMap((group) => Object.values(group));
const anthropicIds = new Set(anthropicRows.map((model) => model.id));
const dataDir = fileURLToPath(new URL("../src/providers/data/", import.meta.url));
const allCatalogRows = readdirSync(dataDir)
	.filter((file) => file.endsWith(".json") && !file.startsWith("."))
	.flatMap((file) => {
		const groups = JSON.parse(readFileSync(`${dataDir}${file}`, "utf8")) as Record<
			string,
			Record<string, CatalogRow>
		>;
		return Object.values(groups).flatMap((group) => Object.values(group).map((row) => ({ file, row })));
	});

describe("Fable 5.5 launch block consistency", () => {
	it("marks the model released only when the committed anthropic catalog lists it", () => {
		expect(FABLE55_LAUNCH.released).toBe(anthropicIds.has(FABLE55_LAUNCH.modelId));
	});

	it("never ships a listed launch row without a published price, in any provider catalog", () => {
		for (const { file, row } of allCatalogRows.filter(({ row }) => isFable55ModelId(row.id))) {
			expect(row.cost?.input ?? 0, `${file}: ${row.id}`).toBeGreaterThan(0);
			expect(row.cost?.output ?? 0, `${file}: ${row.id}`).toBeGreaterThan(0);
		}
	});

	it("never promotes defaults for an unreleased model", () => {
		expect(!FABLE55_LAUNCH.promoteDefaults || FABLE55_LAUNCH.released).toBe(true);
	});
});
