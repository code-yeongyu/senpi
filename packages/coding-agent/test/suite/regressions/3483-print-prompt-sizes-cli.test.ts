import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const sandboxes: string[] = [];
afterAll(() => {
	for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function runSizes(options: { unsafe?: boolean; noKey?: boolean; preset?: boolean } = {}) {
	const sandbox = mkdtempSync(join(tmpdir(), "3483-cli-"));
	sandboxes.push(sandbox);
	const agentDir = join(sandbox, "agent");
	const cwd = join(sandbox, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	writeFileSync(join(cwd, "AGENTS.md"), "PRIVATE_CLI_CONTEXT_3483\n");
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "sizes-fixture",
			defaultModel: options.preset ? "claude-opus-4-8" : "fixture",
		}),
	);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"sizes-fixture": {
					api: "openai-completions",
					baseUrl: "https://invalid.invalid",
					...(options.noKey ? {} : { apiKey: "unused-fixture" }),
					models: [
						{
							id: options.preset ? "claude-opus-4-8" : "fixture",
							name: "Fixture",
							reasoning: false,
							contextWindow: 200000,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	const extension = join(sandbox, "memory.ts");
	writeFileSync(
		extension,
		`export default function(pi) {
		pi.on("session_start", () => {});
		pi.on("before_agent_start", event => {
			console.log("PRIVATE_CLI_NOISE_3483");
			return { systemPrompt: event.systemPrompt + "\\n\\n<memory>PRIVATE_CLI_MEMORY_3483</memory>" };
		}, { previewSafe: ${!options.unsafe} });
	}`,
	);
	const entrypoints = ["alpha", "beta"].map((name) => {
		const directory = join(sandbox, name);
		mkdirSync(directory);
		const path = join(directory, "index.ts");
		writeFileSync(
			path,
			`export default function(pi) {
				pi.on("before_agent_start", event => ({
					systemPrompt: event.systemPrompt + "\\nPRIVATE_CLI_${name}"
				}), { previewSafe: true });
			}`,
		);
		return path;
	});
	const attempted = join(sandbox, "network-attempted");
	const denyNetwork = join(sandbox, "deny-network.mjs");
	writeFileSync(
		denyNetwork,
		`
		import { appendFileSync } from "node:fs";
		import http from "node:http";
		import https from "node:https";
		import net from "node:net";
		const deny = () => { appendFileSync(${JSON.stringify(attempted)}, new Error("Network forbidden").stack + "\\n"); throw new Error("Network forbidden"); };
		globalThis.fetch = deny;
		http.request = http.get = https.request = https.get = deny;
		const connect = net.connect;
		net.connect = net.createConnection = (...args) => {
			// tsx uses a local IPC socket; it is not a network connection.
			if (typeof args[0] === "object" && typeof args[0]?.path === "string") return connect(...args);
			if (typeof args[0] === "string" && !/^\\d+$/.test(args[0])) return connect(...args);
			return deny();
		};
	`,
	);
	const args = [
		join(root, "node_modules/tsx/dist/cli.mjs"),
		"--tsconfig",
		join(root, "tsconfig.json"),
		join(root, "packages/coding-agent/src/cli.ts"),
		"--print-prompt-sizes",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		extension,
		...entrypoints.flatMap((path) => ["-e", path]),
		...(options.preset
			? ["-e", join(root, "packages/coding-agent/src/core/extensions/builtin/prompt-preset/index.ts")]
			: []),
		"--provider",
		"sizes-fixture",
		"--model",
		options.preset ? "claude-opus-4-8" : "fixture",
	];
	const child = spawn(process.execPath, args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME:
				process.platform === "darwin" && sandbox.startsWith("/private/")
					? sandbox.slice("/private".length)
					: sandbox,
			TMPDIR: process.env.TMPDIR,
			NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
			NODE_OPTIONS: `--import=${denyNetwork}`,
			SENPI_CODING_AGENT_DIR: agentDir,
			SENPI_CODING_AGENT_SESSION_DIR: join(sandbox, "sessions"),
			PI_SKIP_VERSION_CHECK: "1",
			PI_SKIP_RUNTIME_NOTICE: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
		// A cold tsx import of the full CLI exceeded 25 s on the review host.
		// Bound startup generously without sleeping or retrying a failed process.
		signal: AbortSignal.timeout(120_000),
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (text: string) => {
		stdout += text;
	});
	child.stderr.setEncoding("utf8").on("data", (text: string) => {
		stderr += text;
	});
	// Deliberately leave stdin open: inspection must never wait for EOF or read a prompt.
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	return { code, stdout, stderr, attempted, network: existsSync(attempted) ? readFileSync(attempted, "utf8") : "" };
}

// #3483: exercise the real flag, exit status, JSON delivery and network boundary.
describe("prompt sizes CLI (#3483)", () => {
	let result: Awaited<ReturnType<typeof runSizes>>;
	beforeAll(async () => {
		// Share one cold CLI startup between the success, credentials and privacy assertions.
		result = await runSizes({ noKey: true });
	}, 130_000);
	it("prints only sizes without reading stdin or making any network request", () => {
		// Given / When: the single shared CLI invocation above.
		// Then
		expect(result.code, result.stderr).toBe(0);
		const report = z
			.object({
				sections: z.array(z.object({ name: z.string(), bytes: z.number() })),
				total: z.object({ bytes: z.number() }),
			})
			.parse(JSON.parse(result.stdout));
		expect(report.sections.some((section) => section.name === "extension:memory" && section.bytes > 0)).toBe(true);
		expect(report.sections.map((section) => section.name)).toEqual(
			expect.arrayContaining(["extension:alpha", "extension:beta"]),
		);
		expect(report.total.bytes).toBe(report.sections.reduce((sum, section) => sum + section.bytes, 0));
		expect(result.stdout).not.toContain("PRIVATE_CLI_");
		// macOS can spell the same home as /var/... and /private/var/....
		expect(result.stdout).not.toContain("3483-cli-");
		expect(result.network).toBe("");
	});

	it("exits nonzero with a JSON reason when a handler is not previewSafe", async () => {
		// Given / When
		const result = await runSizes({ unsafe: true });
		// Then
		expect(result.code, result.stderr).toBe(1);
		const error = z.object({ error: z.object({ reason: z.string() }) }).parse(JSON.parse(result.stdout));
		expect(error.error.reason).toContain("not registered previewSafe");
		expect(error.error.reason).not.toContain("/private~");
		expect(result.stdout).not.toContain("3483-cli-");
		expect(result.network).toBe("");
	}, 130_000);

	it("inspects a resolved model without requiring credentials", () => {
		// Given / When: the shared invocation deliberately has no API key.
		// Then
		expect(result.code, result.stderr).toBe(0);
		const report = z.object({ total: z.object({ bytes: z.number() }) }).parse(JSON.parse(result.stdout));
		expect(report.total.bytes).toBeGreaterThan(0);
		expect(result.network).toBe("");
	});
	it("names the user extensions whose startup hooks still run", () => {
		// Given / When: the shared invocation loads the fixture's session_start handler.
		// Then
		const report = z
			.object({
				thirdPartySessionStart: z.object({ names: z.array(z.string()) }),
			})
			.parse(JSON.parse(result.stdout));
		expect(report.thirdPartySessionStart.names).toEqual(["memory"]);
	});
	it("prints the real preset's sections without the replaced session policy", async () => {
		// Given / When: exercise preset resolution through the actual CLI, with no credentials.
		const preset = await runSizes({ preset: true, noKey: true });
		// Then
		expect(preset.code, preset.stderr).toBe(0);
		const report = z
			.object({
				sections: z.array(z.object({ name: z.string(), source: z.string(), bytes: z.number() })),
				total: z.object({ bytes: z.number() }),
			})
			.parse(JSON.parse(preset.stdout));
		expect(report.sections.find((part) => part.name === "core")?.source).toBe("prompt-preset:claude-opus-4-8");
		expect(report.sections.some((part) => part.name === "session_policy")).toBe(false);
		expect(report.total.bytes).toBe(report.sections.reduce((sum, part) => sum + part.bytes, 0));
		expect(preset.network).toBe("");
	}, 130_000);
});
