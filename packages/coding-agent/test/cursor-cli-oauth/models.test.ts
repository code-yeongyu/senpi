import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_AGENT_ENVIRONMENT_PASSTHROUGH } from "../../src/core/extensions/builtin/cursor-cli-oauth/environment.ts";
import { CursorAgentNotInstalledError } from "../../src/core/extensions/builtin/cursor-cli-oauth/executable.ts";
import {
	type CursorCliModelCatalogDeps,
	parseCursorAgentModelsListing,
	resolveCursorCliModelCatalog,
	STATIC_CURSOR_CLI_MODELS,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/models.ts";
import { runModelsProbe } from "../../src/core/extensions/builtin/cursor-cli-oauth/models-probe.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/cursor-agent-models.txt", import.meta.url));
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "senpi-cursor-models-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function probeDeps(
	now: () => number,
	listing: () => string,
): Pick<CursorCliModelCatalogDeps, "now" | "resolveExecutable" | "runProbe"> {
	return {
		now,
		resolveExecutable: () => "/test/cursor-agent",
		runProbe: vi.fn(async (_executable, stdoutPath, timeoutMs) => {
			expect(timeoutMs).toBe(15_000);
			await writeFile(stdoutPath, listing(), "utf8");
		}),
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("parseCursorAgentModelsListing", () => {
	it("parses the committed listing into grouped identities with contract metadata", async () => {
		const listing = await readFile(FIXTURE_PATH, "utf8");
		const models = parseCursorAgentModelsListing(listing);

		expect(Buffer.byteLength(listing)).toBeGreaterThan(8 * 1024);
		expect(models).toHaveLength(93);
		expect(models.find((model) => model.id === "gemini-3.7-flash")).toMatchObject({
			reasoning: true,
			input: ["text"],
			contextWindow: 1_048_576,
			maxTokens: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(models.find((model) => model.id === "claude-opus-5-thinking")?.contextWindow).toBe(1_000_000);
		expect(models.find((model) => model.id === "gpt-5.6-sol")?.contextWindow).toBe(1_000_000);
		expect(models.find((model) => model.id === "composer-2.5")?.contextWindow).toBe(200_000);
		expect(models.find((model) => model.id === "composer-2.5-fast")?.reasoning).toBe(false);
	});

	it("strips ANSI and ignores malformed, blank, header, and duplicate lines", () => {
		const models = parseCursorAgentModelsListing(
			"Available models:\n\n\u001b[36mclaude-opus-5-thinking-max-fast\u001b[0m - \u001b[1mClaude Opus 5 Thinking Max Fast (300K context)\u001b[0m\nnot a model\nclaude-opus-5-thinking-max-fast - Duplicate\n",
		);

		expect(models).toEqual([
			expect.objectContaining({
				id: "claude-opus-5-thinking-max-fast",
				name: "Claude Opus 5 Thinking Max Fast (300K context)",
				reasoning: false,
				contextWindow: 1_000_000,
			}),
		]);
	});
});

describe("resolveCursorCliModelCatalog", () => {
	it("reuses a fresh cache and refreshes it after the configured TTL", async () => {
		const agentDir = await temporaryDirectory();
		let now = Date.parse("2026-08-17T00:00:00.000Z");
		let listing = "model-a - Model A (200K context)\n";
		const deps = probeDeps(
			() => now,
			() => listing,
		);
		const options = { agentDir, settings: { modelCatalogTtlHours: 2 }, deps };

		await expect(resolveCursorCliModelCatalog(options)).resolves.toMatchObject([{ id: "model-a" }]);
		listing = "model-b-high - Model B High (1M context)\n";
		now += 60 * 60 * 1_000;
		await expect(resolveCursorCliModelCatalog(options)).resolves.toMatchObject([{ id: "model-a" }]);
		now += 2 * 60 * 60 * 1_000;
		await expect(resolveCursorCliModelCatalog(options)).resolves.toMatchObject([{ id: "model-b-high" }]);
		expect(deps.runProbe).toHaveBeenCalledTimes(2);
	});

	it("returns the exact static fallback when the executable is missing", async () => {
		const agentDir = await temporaryDirectory();
		const runProbe = vi.fn<CursorCliModelCatalogDeps["runProbe"]>(async () => {});
		const models = await resolveCursorCliModelCatalog({
			agentDir,
			settings: { modelCatalogTtlHours: 24 },
			deps: {
				resolveExecutable: () => {
					throw new CursorAgentNotInstalledError();
				},
				runProbe,
			},
		});

		expect(runProbe).not.toHaveBeenCalled();
		expect(models).toEqual(STATIC_CURSOR_CLI_MODELS);
		expect(models.map((model) => model.id)).toEqual([
			"auto",
			"composer-2.5",
			"composer-2.5-fast",
			"gpt-5.6-sol",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-5.3-codex",
			"gpt-5.2",
			"claude-opus-5",
			"claude-opus-5-thinking",
			"claude-opus-4-8-thinking",
			"claude-fable-5-thinking",
			"claude-sonnet-5-thinking",
			"gemini-3.7-flash",
			"cursor-grok-4.6",
		]);
	});

	it("captures and parses complete stdout beyond 8 KB through the real process runner", async () => {
		const agentDir = await temporaryDirectory();
		const executable = join(agentDir, "fake-cursor-agent.mjs");
		await writeFile(
			executable,
			`#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nif (process.argv[2] !== "models") process.exit(2);\nprocess.stdout.write(readFileSync(${JSON.stringify(FIXTURE_PATH)}));\n`,
			"utf8",
		);
		await chmod(executable, 0o755);

		const models = await resolveCursorCliModelCatalog({
			agentDir,
			settings: { modelCatalogTtlHours: 24 },
			deps: {
				resolveExecutable: () => executable,
				runProbe: (probeExecutable, stdoutPath, timeoutMs) =>
					runModelsProbe({ executable: probeExecutable, stdoutPath, timeoutMs, home: agentDir }),
			},
		});

		expect(models).toHaveLength(93);
		expect(models.at(-1)?.id).toBe("deepseek-v4-max-fast");
	});

	it("falls back on failed or misleading probes without poisoning an existing cache", async () => {
		const agentDir = await temporaryDirectory();
		let now = 1_000_000;
		const goodDeps = probeDeps(
			() => now,
			() => "model-a - Model A\n",
		);
		await resolveCursorCliModelCatalog({ agentDir, settings: { modelCatalogTtlHours: 1 }, deps: goodDeps });
		now += 2 * 60 * 60 * 1_000;
		const badDeps = probeDeps(
			() => now,
			() => "ERROR - authentication unavailable\n",
		);

		await expect(
			resolveCursorCliModelCatalog({ agentDir, settings: { modelCatalogTtlHours: 1 }, deps: badDeps }),
		).resolves.toEqual(STATIC_CURSOR_CLI_MODELS);

		const cache = await readFile(join(agentDir, "cursor-cli-oauth", "models.json"), "utf8");
		expect(cache).toContain('"model-a"');
		expect(cache).not.toContain("authentication unavailable");
	});
});

describe("runModelsProbe", () => {
	const LEAKABLE_VARIABLES = ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_SERVER", "SENPI_PROBE_SECRET"] as const;
	const previous = new Map<string, string | undefined>();

	afterEach(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		previous.clear();
	});

	it("spawns cursor-agent models with the explicit environment inside the given HOME", async () => {
		// Given: a parent that looks like a remote session and carries a secret
		for (const name of LEAKABLE_VARIABLES) {
			previous.set(name, process.env[name]);
			process.env[name] = `leaked-${name}`;
		}
		const directory = await temporaryDirectory();
		const home = join(directory, "account-home");
		const dump = join(directory, "env.json");
		const stdoutPath = join(directory, "stdout.txt");
		const executable = join(directory, "fake-cursor-agent.mjs");
		await writeFile(
			executable,
			`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nif (process.argv[2] !== "models") process.exit(2);\nwriteFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\nprocess.stdout.write("model-a - Model A\\n");\n`,
			"utf8",
		);
		await chmod(executable, 0o755);

		// When: the probe runs
		await runModelsProbe({ executable, stdoutPath, timeoutMs: 15_000, home });

		// Then: the child saw only the allowlist, rooted in the account HOME
		const childEnv = JSON.parse(await readFile(dump, "utf8")) as Record<string, string>;
		// macOS libSystem injects __CF_USER_TEXT_ENCODING into every child regardless of the env passed to spawn.
		const allowed = new Set<string>([
			"HOME",
			"AGENT_CLI_CREDENTIAL_STORE",
			"__CF_USER_TEXT_ENCODING",
			...CURSOR_AGENT_ENVIRONMENT_PASSTHROUGH,
		]);
		expect(Object.keys(childEnv).filter((key) => !allowed.has(key))).toEqual([]);
		expect(childEnv.HOME).toBe(home);
		expect(childEnv.AGENT_CLI_CREDENTIAL_STORE).toBe("file");
		for (const name of LEAKABLE_VARIABLES) expect(childEnv).not.toHaveProperty(name);
		expect(await readFile(stdoutPath, "utf8")).toBe("model-a - Model A\n");
	});
});
