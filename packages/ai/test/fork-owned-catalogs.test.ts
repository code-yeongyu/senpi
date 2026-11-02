import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.ts";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";

/**
 * models.dev stopped describing `kimi-coding`, so a catalog regeneration emits
 * neither its shard nor its data file. The fork still ships the provider, so it
 * is hand-written like `devin` - and the catalog API has to keep serving it.
 *
 * Without the fork-owned catalog seam the release job is the first thing to
 * notice: it regenerates, the provider vanishes from the generated union, and
 * every call that names it stops type-checking.
 */
describe("fork-owned provider catalogs", () => {
	it("keeps a fork-owned provider out of the generated aggregate", () => {
		expect(Object.keys(MODELS)).not.toContain("kimi-coding");
	});

	it("still lists it as a built-in provider", () => {
		expect(getBuiltinProviders()).toContain("kimi-coding");
	});

	it("still reads its models by id", () => {
		const model = getBuiltinModel("kimi-coding", "kimi-for-coding");
		expect(model.provider).toBe("kimi-coding");
		expect(model.api).toBe("anthropic-messages");
	});

	it("still lists its whole catalog", () => {
		const models = getBuiltinModels("kimi-coding");
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.provider === "kimi-coding")).toBe(true);
	});
});
