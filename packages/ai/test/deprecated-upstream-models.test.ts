import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";

// Contract (senpi 2026.10.21-1): a model models.dev marks deprecated stays in the catalog, labeled `deprecated`,
// when the previous catalog already shipped it, so a user on it keeps a working model. xiaomi-models.test.ts
// covers the other half: a deprecated model the catalog never shipped is not added.
describe("upstream-deprecated models", () => {
	it("keeps shipped GitHub Copilot models that models.dev deprecated, labeled deprecated", () => {
		const models = new Map(getModels("github-copilot").map((model) => [model.id, model]));
		for (const id of ["claude-opus-4.7", "gpt-5.5", "gpt-5.4"]) {
			expect(models.get(id)?.deprecated).toBe(true);
		}
	});

	it("leaves current models unlabeled", () => {
		const fable = getModels("github-copilot").find((model) => model.id === "claude-fable-5");
		expect(fable).toBeDefined();
		expect(fable?.deprecated).toBeUndefined();
	});
});
