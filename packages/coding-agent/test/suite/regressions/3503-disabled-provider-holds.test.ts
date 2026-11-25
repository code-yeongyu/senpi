import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// senpi#3503: a provider disabled in models.json stays disabled for every request and every refresh.
function provider(id: string) {
	return {
		baseUrl: `https://${id}.example.test/v1`,
		api: "openai-completions",
		apiKey: `test-${id}-key`,
		models: [{ id: `${id}-model`, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
	};
}

describe("a provider disabled in models.json stays disabled (senpi#3503)", () => {
	let dir: string;
	let modelsPath: string;

	beforeEach(() => {
		dir = join(tmpdir(), `senpi-3503-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		modelsPath = join(dir, "models.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeModels(content: unknown): void {
		writeFileSync(modelsPath, typeof content === "string" ? content : JSON.stringify(content));
	}

	async function runtimeWithBothEnabled(): Promise<ModelRuntime> {
		writeModels({ providers: { alpha: provider("alpha"), beta: provider("beta") } });
		const runtime = await ModelRuntime.create({
			modelsPath,
			credentials: new InMemoryCredentialStore(),
			refreshOnCreate: false,
		});
		expect(runtime.getModel("alpha", "alpha-model")).toBeDefined();
		return runtime;
	}

	it("refuses a request to a provider disabled after the runtime was created, even when only another provider refreshed", async () => {
		const runtime = await runtimeWithBothEnabled();
		const alpha = runtime.getModel("alpha", "alpha-model");
		if (!alpha) throw new Error("alpha-model missing");

		writeModels({ disabledProviders: ["alpha"], providers: { alpha: provider("alpha"), beta: provider("beta") } });
		await runtime.refresh({ providers: ["beta"], allowNetwork: false });

		expect(runtime.getModel("alpha", "alpha-model")).toBeUndefined();
		await expect(runtime.prepareSimpleRequest(alpha)).rejects.toThrow(/alpha.*disabled/);
	});

	it("keeps the last valid disabled providers when models.json becomes invalid, and reports the error", async () => {
		const runtime = await runtimeWithBothEnabled();
		expect(runtime.getModels("openai").length).toBeGreaterThan(0);
		writeModels({ disabledProviders: ["openai"], providers: { beta: provider("beta") } });
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModels("openai")).toEqual([]);

		writeModels("{ not json");
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getError()).toMatch(/Failed to parse models\.json/);
		expect(runtime.getModels("openai")).toEqual([]);
	});

	it("keeps an enabled provider usable", async () => {
		const runtime = await runtimeWithBothEnabled();
		const beta = runtime.getModel("beta", "beta-model");
		if (!beta) throw new Error("beta-model missing");

		await expect(runtime.prepareSimpleRequest(beta)).resolves.toMatchObject({ model: { provider: "beta" } });
	});
});
