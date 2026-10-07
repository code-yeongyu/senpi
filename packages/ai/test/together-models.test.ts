import { afterEach, describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

// The Together catalog is regenerated from models.dev before every release, so models come and
// go (senpi #2545). These tests assert what every Together entry must satisfy, whichever models
// the current catalog holds, instead of naming catalog ids.
const togetherModels = getModels("together");

function effortLevels(model: (typeof togetherModels)[number]): string[] {
	const map = model.thinkingLevelMap ?? {};
	return Object.values(map).filter((value): value is string => typeof value === "string");
}

describe("Together models", () => {
	it("registers the catalog's models with the Together provider", () => {
		expect(togetherModels.length).toBeGreaterThan(0);
		const ids = togetherModels.map((model) => model.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("sends every model through Together's OpenAI-compatible Chat Completions API", () => {
		for (const model of togetherModels) {
			expect(model, model.id).toMatchObject({
				api: "openai-completions",
				provider: "together",
				baseUrl: "https://api.together.ai/v1",
			});
			expect(model.compat, model.id).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsStrictMode: false,
				maxTokensField: "max_tokens",
			});
		}
	});

	it("sends a reasoning effort only for models whose thinking levels map to one", () => {
		for (const model of togetherModels) {
			const levels = effortLevels(model);
			expect(model.compat?.supportsReasoningEffort === true, model.id).toBe(levels.length > 0);
			for (const level of levels) expect(["low", "medium", "high"], model.id).toContain(level);
			if (model.compat?.thinkingFormat === "openai") {
				expect(model.compat.supportsReasoningEffort, model.id).toBe(true);
			}
		}
	});

	it("gives models without reasoning no thinking controls", () => {
		for (const model of togetherModels.filter((entry) => !entry.reasoning)) {
			expect(model.thinkingLevelMap, model.id).toBeUndefined();
			expect(model.compat?.supportsReasoningEffort, model.id).toBe(false);
		}
	});

	it("resolves no model for an id the Together catalog does not list", () => {
		expect(getModel("together", "together-test/not-a-catalog-model" as never)).toBeUndefined();
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});

	it("resolves no Together key when TOGETHER_API_KEY is unset", () => {
		delete process.env.TOGETHER_API_KEY;

		expect(getEnvApiKey("together")).toBeUndefined();
	});
});
