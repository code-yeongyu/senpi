import { afterEach, describe, expect, it } from "vitest";
import { resetGrepEngineForTests, resolveGrepEngine } from "../../src/core/tools/grep/select-engine.ts";

describe("resolveGrepEngine", () => {
	afterEach(() => resetGrepEngineForTests());

	it("resolves rg when explicitly selected", async () => {
		const engine = await resolveGrepEngine({ env: { SENPI_GREP_ENGINE: "rg" } });
		expect(engine.name).toBe("rg");
	});

	it("rejects unavailable native engine with ENGINE_UNAVAILABLE", async () => {
		await expect(
			resolveGrepEngine({ env: { SENPI_GREP_ENGINE: "native", SENPI_GREP_NATIVE_PATH: "/nonexistent" } }),
		).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
	});
});
