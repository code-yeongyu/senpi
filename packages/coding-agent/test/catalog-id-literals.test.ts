import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

// senpi#1955: a test that looks up a live catalog id by string (`registry.find("p", "id")`, `runtime.getModel("p", "id")`)
// is invisible to tsc and breaks the day a catalog regen drops that id. Pick ids with test/support/catalog-ids.ts instead.
// A lookup may stay literal only when the test is about that exact catalog entry; list it here with the reason.
const ALLOWED: ReadonlyArray<{ file: string; provider: string; id: string; why: string }> = [
	{
		file: "model-runtime-catalog-service-tier.test.ts",
		provider: "openai",
		id: "gpt-5.5-fast",
		why: "the -fast service-tier variant is the subject",
	},
	{
		file: "model-runtime-catalog-service-tier.test.ts",
		provider: "openai",
		id: "gpt-5.4-mini-fast",
		why: "the -fast service-tier variant is the subject",
	},
	{
		file: "sdk-service-tier-wire.test.ts",
		provider: "chatgpt-subscription",
		id: "gpt-6.1-sol-ultrafast",
		why: "the -ultrafast service-tier variant is the subject",
	},
	{
		file: "model-runtime-cloudflare-compat.test.ts",
		provider: "cloudflare-ai-gateway",
		id: "workers-ai/@cf/moonshotai/kimi-k2.6",
		why: "the compat of that Workers AI model is the subject",
	},
	{
		file: "model-runtime-images.test.ts",
		provider: "openrouter",
		id: "openrouter/auto",
		why: "the stable auto router id",
	},
	{
		file: "model-registry.test.ts",
		provider: "anthropic",
		id: "claude-haiku-5-5",
		why: "Claude Haiku 5.5's 100K price band and 1M opt-in is the subject (#2892)",
	},
	{
		file: "model-registry.test.ts",
		provider: "anthropic",
		id: "claude-fable-5",
		why: "that model's built-in compat is the subject",
	},
	{
		file: "model-registry.test.ts",
		provider: "anthropic",
		id: "claude-sonnet-4-6",
		why: "the prompt-cache merge onto that model's own defaults is the subject",
	},
];

const TEST_ROOT = new URL(".", import.meta.url).pathname;
// A method call on a receiver (`registry.find`, `runtime.getModel`): not the typed `getModel` from pi-ai, which tsc guards.
const LOOKUP = /[\w)\]]\.(?:find|getModel)\(\s*"([a-z0-9-]+)",\s*"([^"]+)"/g;

function testFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "fixtures" ? [] : testFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("catalog id literals in tests (senpi#1955)", () => {
	it("looks up no live catalog id by string outside the allowlist", () => {
		const providers = getBuiltinProviders();
		const catalog = new Map<string, Set<string>>();
		const idsOf = (provider: string): Set<string> => {
			let ids = catalog.get(provider);
			if (!ids) {
				const builtin = providers.find((candidate) => candidate === provider);
				ids = new Set(builtin === undefined ? [] : getBuiltinModels(builtin).map((model) => model.id));
				catalog.set(provider, ids);
			}
			return ids;
		};
		const offending: string[] = [];
		for (const path of testFiles(TEST_ROOT)) {
			const file = relative(TEST_ROOT, path);
			const source = readFileSync(path, "utf8");
			for (const match of source.matchAll(LOOKUP)) {
				const [, provider = "", id = ""] = match;
				if (!idsOf(provider).has(id)) continue;
				const allowed = ALLOWED.some(
					(entry) => file.endsWith(entry.file) && entry.provider === provider && entry.id === id,
				);
				if (!allowed) offending.push(`${file}: ${provider}/${id}`);
			}
		}
		expect(offending).toEqual([]);
	});
});
