import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../../../src/core/model-config.ts";
import { discoverProviderModels, ModelsDiscoveryError } from "../../../src/core/model-discovery.ts";

// code-yeongyu/oh-my-openagent#14414: a missing or empty models.json made `models discover`
// print a raw ENOENT or "JSON Parse error: Unexpected EOF" instead of saying what it needs.
describe("models.json missing or empty (oh-my-openagent#14414)", () => {
	let tempDir: string;
	let modelsPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-14414-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsPath = join(tempDir, "models.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function discoverError(): Promise<ModelsDiscoveryError> {
		const failure = await discoverProviderModels({ providerId: "local", modelsPath, auth: {} }).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (!(failure instanceof ModelsDiscoveryError)) throw new Error(`expected ModelsDiscoveryError, got ${failure}`);
		return failure;
	}

	it("explains how to declare the provider when the file does not exist", async () => {
		const { message } = await discoverError();

		expect(message).not.toContain("ENOENT");
		expect(message).toContain(`Provider "local" is not declared in ${modelsPath}`);
		expect(message).toContain('"baseUrl"');
		expect(message).toContain('"api": "openai-completions"');
	});

	it.each(["", "  \n\t"])("treats an empty file (%j) as declaring no providers", async (content) => {
		writeFileSync(modelsPath, content);

		const { message } = await discoverError();

		expect(message).not.toMatch(/parse/i);
		expect(message).toContain(`Provider "local" is not declared in ${modelsPath}`);
		expect(message).toContain('"baseUrl"');
	});

	it("names the file and the line and column of malformed JSON", async () => {
		writeFileSync(modelsPath, '{\n  "providers": {\n    "local": }\n}\n');

		const { message } = await discoverError();

		expect(message).toContain(modelsPath);
		expect(message).toContain("line 3, column 14");
	});

	it.each(["", "\n  \n"])("loads an empty file (%j) as no custom providers everywhere", async (content) => {
		writeFileSync(modelsPath, content);

		for (const config of [await ModelConfig.load(modelsPath), ModelConfig.loadSync(modelsPath)]) {
			expect(config.getError()).toBeUndefined();
			expect(config.getProvider("local")).toBeUndefined();
		}
	});

	it("reports the line and column when the runtime loader meets malformed JSON", async () => {
		writeFileSync(modelsPath, '{ "providers": { "local": [ }');

		const error = (await ModelConfig.load(modelsPath)).getError();

		expect(error).toContain(modelsPath);
		expect(error).toContain("line 1, column 29");
	});
});
