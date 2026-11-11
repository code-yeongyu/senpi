import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { copyJsonModelGenerationFixture } from "./json-model-generation-fixture.ts";

type Catalog = Record<string, Record<string, Model<Api>>>;

const sourceModel = {
	tool_call: true,
	reasoning: true,
	modalities: { input: ["text", "image"], output: ["text"] },
	cost: { input: 8, output: 40, cache_read: 0.2, cache_write: 10 },
	limit: { context: 1_000_000, output: 128_000 },
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
};

// The compat set every Fable 5.x row carries on the Messages API (senpi#3893).
const fableCompat = {
	forceAdaptiveThinking: true,
	supportsDisabledThinking: false,
	supportsMidConvoEffort: true,
	supportsMidConvoSystemMessages: true,
	supportsMidConvoToolChanges: true,
};

function generateAnthropicCatalog(models: Record<string, Record<string, unknown>>): Record<string, Model<Api>> {
	const root = mkdtempSync(join(tmpdir(), "senpi-fable52-"));
	try {
		const isolated = join(root, "package");
		copyJsonModelGenerationFixture(isolated);
		writeFileSync(join(isolated, "src/providers/data/anthropic.json"), JSON.stringify({}));
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
		return JSON.parse(readFileSync(join(root, "output/providers/anthropic.json"), "utf8")) as Record<
			string,
			Model<Api>
		>;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("Claude Fable 5.2 generation", () => {
	// Opus 4.8 is a permitted target but cannot take a mid-conversation effort change, so the generator drops it.
	it("gives a listed Fable/Mythos 5.2 row the Fable compat set and its permitted refusal fallbacks", () => {
		const ids = ["claude-opus-4-8", "claude-opus-5", "claude-fable-5-2", "claude-mythos-5-2"];
		const generated = generateAnthropicCatalog(
			Object.fromEntries(ids.map((id) => [id, { ...sourceModel, id, name: id }])),
		);

		for (const id of ["claude-fable-5-2", "claude-mythos-5-2"]) {
			expect(generated[id], id).toMatchObject({
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
				compat: fableCompat,
			});
		}
		expect(generated["claude-fable-5-2"]?.compat).toMatchObject({
			allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-5" }],
		});
	});
});

const dataDir = fileURLToPath(new URL("../src/providers/data/", import.meta.url));
const committedRows = readdirSync(dataDir)
	.filter((file) => file.endsWith(".json") && !file.startsWith("."))
	.flatMap((file) => {
		const catalog = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as Catalog;
		return Object.values(catalog).flatMap((group) => Object.values(group).map((row) => ({ file, row })));
	});

describe("committed Claude Fable 5.2 catalog", () => {
	it("ships claude-fable-5-2 on the anthropic provider with a published price and the Fable compat set", () => {
		const row = committedRows.find(
			({ file, row }) => file === "anthropic.json" && row.id === "claude-fable-5-2",
		)?.row;
		expect(row).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: { ...fableCompat, supportsStrictTools: true },
		});
		expect(row?.cost.input).toBeGreaterThan(0);
		expect(row?.cost.output).toBeGreaterThan(0);
	});

	it("never ships the provisional Fable/Mythos 5.5 id in any provider catalog", () => {
		const provisional = committedRows.filter(({ row }) => /(?:fable|mythos)-5[.-]5(?:$|[^0-9])/.test(row.id));
		expect(provisional.map(({ file, row }) => `${file}: ${row.id}`)).toEqual([]);
	});
});
