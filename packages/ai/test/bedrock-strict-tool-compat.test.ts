/**
 * Guards the Bedrock global GPT-5.6 strict JSON-schema tool capability.
 *
 * `bedrock-converse-stream.ts` reads `model.compat?.supportsStrictMode ?? false`, so a
 * missing `compat` object silently downgrades `constrainedSampling.strict: "require"` to an
 * unsupported error and `"prefer"` to an unconstrained schema. models.dev does not report
 * `structured_output` for the `global.` cross-region inference profiles even though the
 * regional `openai.gpt-5.6-*` entries carry it, so a catalog regeneration can drop the field
 * without any other visible diff. These tests fail on both the shipped data and the generator
 * so the next silent drop breaks CI instead of production requests.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import bedrockData from "../src/providers/data/amazon-bedrock.json" with { type: "json" };

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

const STRICT_MODE_MODEL_IDS = [
	"global.openai.gpt-5.6-luna",
	"global.openai.gpt-5.6-sol",
	"global.openai.gpt-5.6-terra",
] as const;

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Bedrock global GPT-5.6 strict tool compat", () => {
	it("ships supportsStrictMode on every global GPT-5.6 entry", () => {
		const models = bedrockData["bedrock-converse-stream"] as Record<
			string,
			{ compat?: { supportsStrictMode?: boolean } }
		>;
		for (const modelId of STRICT_MODE_MODEL_IDS) {
			expect(models[modelId], `${modelId} is missing from the shipped Bedrock catalog`).toBeDefined();
			expect(models[modelId].compat?.supportsStrictMode, `${modelId} lost compat.supportsStrictMode`).toBe(true);
		}
	});

	it("re-applies supportsStrictMode when regeneration sees no upstream structured_output", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-bedrock-strict-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}

		// Upstream shape that caused the drop: tool-capable global profiles with no
		// `structured_output` flag, so the generator's models.dev branch emits no `compat`.
		const catalog = {
			"amazon-bedrock": {
				models: Object.fromEntries(
					STRICT_MODE_MODEL_IDS.map((id) => [
						id,
						{ id, name: id, tool_call: true, reasoning: true, limit: { context: 1050000, output: 128000 } },
					]),
				),
			},
		};
		const preloadPath = join(fixtureRoot, "mock-fetch.mjs");
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  return new Response("offline", { status: 503 });\n` +
				`};\n`,
		);

		const jsonOutput = join(fixtureRoot, "catalog");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				jsonOutput,
			],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 60_000 },
		);

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const generated = JSON.parse(readFileSync(join(jsonOutput, "models.json"), "utf8")) as Record<
			string,
			Record<string, { compat?: { supportsStrictMode?: boolean } }>
		>;
		for (const modelId of STRICT_MODE_MODEL_IDS) {
			expect(
				generated["amazon-bedrock"]?.[modelId]?.compat?.supportsStrictMode,
				`regeneration dropped compat.supportsStrictMode for ${modelId}`,
			).toBe(true);
		}
	});
});
