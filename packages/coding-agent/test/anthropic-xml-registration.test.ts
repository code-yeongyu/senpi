import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getProtocol, getToolCallFormat } from "../../ai/src/tool-call-middleware/index.ts";
import type { Api, Model, Tool } from "../../ai/src/types.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const bashTool: Tool = {
	name: "Bash",
	description: "Run a shell command",
	parameters: Type.Object({
		command: Type.String(),
	}),
};

const openAiCompletionsModel = {
	id: "anthropic-xml-model",
	name: "Anthropic XML model",
	api: "openai-completions",
	provider: "registration-test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
	compat: { toolCallFormat: "anthropic-xml" },
} satisfies Model<"openai-completions">;

const openAiCompletionsModelWithoutCompat = {
	...openAiCompletionsModel,
	compat: undefined,
} satisfies Model<"openai-completions">;

const nonCompletionsModel: Model<Api> = {
	...openAiCompletionsModel,
	api: "anthropic-messages",
};

describe("anthropic-xml registration", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir !== undefined) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("parses a Bash invocation when the anthropic-xml protocol is resolved", () => {
		// Given
		const generatedText = '<invoke name="Bash"><parameter name="command">printf registration-ok</parameter></invoke>';

		// When
		const parsed = getProtocol("anthropic-xml").parseGeneratedText(generatedText, [bashTool]);

		// Then
		expect(parsed).toEqual([
			{
				name: "Bash",
				arguments: { command: "printf registration-ok" },
			},
		]);
	});

	it("activates anthropic-xml for an openai-completions model with compat", () => {
		// Given
		const model = openAiCompletionsModel;

		// When
		const format = getToolCallFormat(model);

		// Then
		expect(format).toBe("anthropic-xml");
	});

	it("does not activate without compatibility settings", () => {
		// Given
		const model = openAiCompletionsModelWithoutCompat;

		// When
		const format = getToolCallFormat(model);

		// Then
		expect(format).toBeUndefined();
	});

	it("does not activate for a non-openai-completions API", () => {
		// Given
		const model = nonCompletionsModel;

		// When
		const format = getToolCallFormat(model);

		// Then
		expect(format).toBeUndefined();
	});

	it("accepts anthropic-xml in a models.json compatibility block", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-anthropic-xml-registration-"));
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"registration-test": {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						compat: { toolCallFormat: "anthropic-xml" },
						models: [{ id: "anthropic-xml-model" }],
					},
				},
			}),
		);

		// When
		const registry = ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), modelsJsonPath);

		// Then
		expect(registry.getError()).toBeUndefined();
		expect(registry.find("registration-test", "anthropic-xml-model")?.id).toBe("anthropic-xml-model");
	});
});
