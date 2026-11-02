import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir !== undefined) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createProviderWithUnregisteredApi() {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-composer-unknown-api-"));
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				kiro: {
					api: "kiro-api",
					apiKey: "test-key",
					baseUrl: "https://example.invalid/v1",
					models: [{ id: "claude-x" }],
				},
			},
		}),
	);

	const provider = composeModelProvider("kiro", undefined, ModelConfig.loadSync(modelsPath), undefined);
	const model = provider.getModels()[0];
	if (model === undefined) throw new Error("Expected the models.json custom model");
	return { provider, model };
}

describe("composed provider with an unregistered api", () => {
	// Incident: a session model resolved to api "kiro-api" with no registered
	// implementation; the bare "No API provider registered for api: kiro-api"
	// error gave the user nothing to act on.
	it("names the model and the fix in the stream error", async () => {
		const { provider, model } = createProviderWithUnregisteredApi();

		const stream = provider.stream(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			}),
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API provider registered for api: kiro-api");
		expect(result.errorMessage).toContain('model "kiro/claude-x"');
		expect(result.errorMessage).toContain("models.json");
	});
});
