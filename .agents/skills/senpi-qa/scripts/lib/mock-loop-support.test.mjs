import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeMockModelsJson } from "./mock-loop-support.mjs";

// senpi#3312: a billing error skips every chain entry on the spent provider, so the billing-swap scenario needs its
// fallback model registered under a second provider on the same local server.
test("writeMockModelsJson registers a model with a provider field under that provider", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-qa-models-"));
	try {
		const server = { url: "http://127.0.0.1:1/v1", origin: "http://127.0.0.1:1" };
		writeMockModelsJson(agentDir, server, "openai-completions", {}, {
			models: [{ id: "mock-model-fallback", provider: "mock-backup" }],
		});
		const { providers } = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));

		assert.deepEqual(Object.keys(providers).sort(), ["mock", "mock-backup"]);
		assert.deepEqual(providers.mock.models.map((model) => model.id), ["mock-model"]);
		assert.deepEqual(providers["mock-backup"].models.map((model) => model.id), ["mock-model-fallback"]);
		assert.equal(providers["mock-backup"].baseUrl, server.url);
		assert.equal("provider" in providers["mock-backup"].models[0], false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
