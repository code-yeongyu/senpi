import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { FABLE55_LAUNCH } from "../src/utils/fable55-launch.ts";
import { copyJsonModelGenerationFixture } from "./json-model-generation-fixture.ts";

const modelId = FABLE55_LAUNCH.modelId;

// senpi#3893: synthetic values test source fidelity, not an unreleased model's price card.
const sourceModel = {
	name: "Synthetic launch fixture",
	tool_call: true,
	reasoning: true,
	modalities: { input: ["text", "image"], output: ["text"] },
	cost: { input: 7.25, output: 31.5, cache_read: 0.73, cache_write: 9.06 },
	limit: { context: 345678, output: 23456 },
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
};

describe("Fable 5.5 launch generation", () => {
	// The sandbox catalog is a fixture, never the committed one: the launch refresh commits a real 5.5 row (senpi#3893).
	it.each([
		["listed", false],
		["absent", false],
		["deprecated", false],
		["deprecated", true],
	] as const)("uses live metadata only when the model is %s (shipped before: %s)", (status, shippedBefore) => {
		const root = mkdtempSync(join(tmpdir(), "senpi-fable55-"));
		try {
			const isolated = join(root, "package");
			copyJsonModelGenerationFixture(isolated);
			const shippedCatalog = shippedBefore
				? { "anthropic-messages": { [`chat:${modelId}`]: { id: modelId, provider: "anthropic" } } }
				: {};
			writeFileSync(join(isolated, "src/providers/data/anthropic.json"), JSON.stringify(shippedCatalog));
			const models = {
				"claude-opus-5": { ...sourceModel, id: "claude-opus-5" },
				...(status === "absent" ? {} : { [modelId]: { ...sourceModel, id: modelId, status } }),
			};
			const preload = join(root, "catalog.mjs");
			writeFileSync(
				preload,
				`const catalog = ${JSON.stringify({ anthropic: { models } })};
globalThis.fetch = async (input) => {
	const url = String(input);
	if (url === "https://models.dev/api.json") return Response.json(catalog);
	if (url === "https://openrouter.ai/api/v1/models" ||
		url === "https://ai-gateway.vercel.sh/v1/models" ||
		url === "https://apis.opengateway.ai/v1/models" ||
		url.includes("api.nvidia.com")) return Response.json({ data: [] });
	throw new Error("Unexpected fetch: " + url);
};`,
			);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					pathToFileURL(preload).href,
					"scripts/generate-models.ts",
					"--json-only",
					"--json-output",
					join(root, "output"),
				],
				{ cwd: isolated, encoding: "utf8", timeout: 30_000 },
			);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			const generated = JSON.parse(readFileSync(join(root, "output/providers/anthropic.json"), "utf8")) as Record<
				string,
				Model<Api>
			>;
			if (status === "deprecated" && shippedBefore) {
				expect(generated[modelId]).toMatchObject({ id: modelId, deprecated: true });
				return;
			}
			if (status !== "listed") {
				expect(generated[modelId]).toBeUndefined();
				return;
			}
			expect(generated[modelId]).toMatchObject({
				contextWindow: 345678,
				maxTokens: 23456,
				cost: { input: 7.25, output: 31.5, cacheRead: 0.73, cacheWrite: 9.06 },
				compat: {
					forceAdaptiveThinking: true,
					supportsMidConvoEffort: true,
					supportsMidConvoSystemMessages: true,
					supportsMidConvoToolChanges: true,
					allowedFallbackModels: [
						{
							provider: "anthropic",
							model: "claude-opus-5",
							cost: { input: 7.25, output: 31.5, cacheRead: 0.73, cacheWrite: 9.06 },
						},
					],
				},
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
