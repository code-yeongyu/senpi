import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation", () => {
	it("omits reasoning metadata for unsupported GLM-5.3 variants in generated output", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-glm-5-3-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const outputDir = join(fixtureRoot, "output");
		const preloadPath = join(fixtureRoot, "mock-models.mjs");
		const unsupportedVariants = ["glm-5.3-turbo", "glm-5.3-xl", "glm-5.3-anything-else"];
		const sourceModels = Object.fromEntries(
			unsupportedVariants.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: true,
					reasoning: true,
					reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
				},
			]),
		);
		const catalog = {
			"zai-coding-plan": { models: sourceModels },
			"zhipuai-coding-plan": { models: sourceModels },
		};
		writeFileSync(
			preloadPath,
			`const modelsDev = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(modelsDev), { status: 200 });\n` +
				`  if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === "https://ai-gateway.vercel.sh/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === "https://apis.opengateway.ai/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);

		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				outputDir,
			],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);

		expect(result.status).toBe(0);
		const generated = JSON.parse(readFileSync(join(outputDir, "providers", "zai.json"), "utf8"));
		for (const id of unsupportedVariants) {
			expect(generated[id]).toBeDefined();
			expect(generated[id].thinkingLevelMap).toBeUndefined();
			expect(generated[id].compat?.supportsReasoningEffort).not.toBe(true);
		}
	});

	it("regenerates selected providers without changing unselected artifacts", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-selected-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const catalog = {
			"zai-coding-plan": {
				models: {
					"glm-4.7": { id: "glm-4.7", name: "GLM 4.7", tool_call: true, reasoning: true },
				},
			},
			"zhipuai-coding-plan": {
				models: {
					"glm-4.7": { id: "glm-4.7", name: "GLM 4.7 CN", tool_call: true, reasoning: true },
				},
			},
		};
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === "https://ai-gateway.vercel.sh/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === "https://apis.opengateway.ai/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url.includes("api.nvidia.com")) return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);
		const selected = ["zai", "zai-coding-cn"];
		const unselectedPath = join(isolatedPackageRoot, "src/providers/data/openrouter.json");
		const unselectedBefore = readFileSync(unselectedPath, "utf8");
		const args = [
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--providers",
			selected.join(","),
			"--generated-at",
			"2026-09-06T00:00:00.000Z",
		];

		const first = spawnSync(process.execPath, args, { cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 });
		expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
		expect(readFileSync(unselectedPath, "utf8")).toBe(unselectedBefore);
		const selectedFirst = selected.map((provider) =>
			readFileSync(join(isolatedPackageRoot, `src/providers/data/${provider}.json`), "utf8"),
		);
		const manifestFirst = readFileSync(join(isolatedPackageRoot, "src/providers/data/.manifest.json"), "utf8");

		const second = spawnSync(process.execPath, args, { cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 });
		expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(
			selected.map((provider) =>
				readFileSync(join(isolatedPackageRoot, `src/providers/data/${provider}.json`), "utf8"),
			),
		).toEqual(selectedFirst);
		expect(readFileSync(join(isolatedPackageRoot, "src/providers/data/.manifest.json"), "utf8")).toBe(manifestFirst);
		expect(
			spawnSync(process.execPath, ["scripts/check-model-data.ts"], { cwd: isolatedPackageRoot, encoding: "utf8" })
				.status,
		).toBe(0);

		const invalid = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--providers", "zai,missing"],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
		expect(invalid.status).toBe(1);
		expect(`${invalid.stdout}\n${invalid.stderr}`).toContain("Unknown provider selector: missing");
		expect(readFileSync(unselectedPath, "utf8")).toBe(unselectedBefore);
		for (const providerId of ["__proto__", "constructor", "toString"]) {
			const inherited = spawnSync(
				process.execPath,
				["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--providers", providerId],
				{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
			);
			expect(inherited.status, `${providerId}: ${inherited.stdout}\n${inherited.stderr}`).toBe(1);
			expect(readFileSync(join(isolatedPackageRoot, "src/providers/data/.manifest.json"), "utf8")).toBe(
				manifestFirst,
			);
			expect(readFileSync(unselectedPath, "utf8")).toBe(unselectedBefore);
		}
	});

	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});
});
