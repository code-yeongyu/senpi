import { describe, expect, it } from "vitest";
import {
	STATIC_CMD_CLI_MODELS,
	parseCmdCliModelsListing,
	resolveCmdCliModels,
} from "../../src/core/extensions/builtin/cmd-cli/models.ts";

describe("cmd-cli models", () => {
	it("defines static fallback models with expected attributes", () => {
		expect(STATIC_CMD_CLI_MODELS.length).toBeGreaterThanOrEqual(2);
		const ids = STATIC_CMD_CLI_MODELS.map((m) => m.id);
		expect(ids).not.toContain("default");
		expect(ids).toContain("deepseek/deepseek-v4.1-flash");
		expect(ids).toContain("claude-sonnet-5-5");

		for (const model of STATIC_CMD_CLI_MODELS) {
			if (!("maxTokens" in model) || !("reasoning" in model)) throw new Error("static models must be text models");
			expect(model.reasoning).toBe(true);
			expect(model.input).toEqual(["text"]);
			expect(model.contextWindow).toBe(200_000);
			expect(model.maxTokens).toBe(64_000);
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	const REAL_LISTING = [
		"Available models  ·  95 models",
		"",
		"Open Source",
		"",
		"deepseek/deepseek-v4.1-flash           V4.1 reasoning",
		"",
		"Anthropic",
		"",
		"claude-opus-5-5                        most intelligent Opus",
		"",
		'Pass the full id, or just the short name after the last "/":',
		"cmd --model moonshotai/kimi-k2.5",
		"cmd --model kimi-k2.5",
		"",
		"Docs:  https://commandcode.ai/docs/reference/cli/models",
		"",
		"Decision models (headless only)",
		"typesafe/jev  typed questions in, probabilities out",
		"",
	].join("\n");

	it("keeps only chat model rows from the complete real listing", () => {
		expect(parseCmdCliModelsListing(REAL_LISTING).map((m) => m.id)).toEqual([
			"deepseek/deepseek-v4.1-flash",
			"claude-opus-5-5",
		]);
	});

	it("strips ANSI escape sequences", () => {
		const models = parseCmdCliModelsListing("\u001B[32mmodel-green\u001B[0m  \u001B[1mGreen\u001B[0m\n");
		expect(models.map((m) => m.id)).toEqual(["model-green"]);
	});

	it("deduplicates models by id", () => {
		const models = parseCmdCliModelsListing("model-dup  First copy\nmodel-dup  Second copy\n");
		expect(models.map((m) => m.id)).toEqual(["model-dup"]);
	});

	it("falls back to STATIC_CMD_CLI_MODELS when listing is empty or comments only", () => {
		const raw = `
# Comment line
# Another comment
`;
		const models = parseCmdCliModelsListing(raw);
		expect(models).toEqual(STATIC_CMD_CLI_MODELS);
	});

	it("resolves models via injected runner", async () => {
		const runner = async () => "custom-model  Custom Model\n";
		const models = await resolveCmdCliModels({
			executable: "/mock/cmd",
			runner,
		});
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe("custom-model");
		expect(models[0].name).toBe("custom-model");
	});

	it("falls back to STATIC_CMD_CLI_MODELS on runner error", async () => {
		const runner = async () => {
			throw new Error("Command failed");
		};
		const models = await resolveCmdCliModels({
			executable: "/mock/cmd",
			runner,
		});
		expect(models).toEqual(STATIC_CMD_CLI_MODELS);
	});

	it("falls back to STATIC_CMD_CLI_MODELS when executable is missing", async () => {
		const models = await resolveCmdCliModels({
			executableDeps: {
				env: () => undefined,
				settings: {},
				isExecutableFile: () => false,
			},
		});
		expect(models).toEqual(STATIC_CMD_CLI_MODELS);
	});
});
