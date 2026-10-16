import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const sandboxes: string[] = [];
afterEach(() => {
	for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function runSizes(options: { unsafe?: boolean; noKey?: boolean } = {}) {
	const sandbox = mkdtempSync(join(tmpdir(), "3483-cli-"));
	sandboxes.push(sandbox);
	const agentDir = join(sandbox, "agent");
	const cwd = join(sandbox, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	writeFileSync(join(cwd, "AGENTS.md"), "PRIVATE_CLI_CONTEXT_3483\n");
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "sizes-fixture", defaultModel: "fixture" }),
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
							id: "fixture",
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
		pi.on("before_agent_start", event => {
			console.log("PRIVATE_CLI_NOISE_3483");
			return { systemPrompt: event.systemPrompt + "\\n\\n<memory>PRIVATE_CLI_MEMORY_3483</memory>" };
		}, { previewSafe: ${!options.unsafe} });
	}`,
	);
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
		"--provider",
		"sizes-fixture",
		"--model",
		"fixture",
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
		signal: AbortSignal.timeout(25_000),
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
	it("prints only sizes without reading stdin or making any network request", async () => {
		// Given / When
		const result = await runSizes();
		// Then
		expect(result.code, result.stderr).toBe(0);
		const report = z
			.object({
				sections: z.array(z.object({ name: z.string(), bytes: z.number() })),
				total: z.object({ bytes: z.number() }),
			})
			.parse(JSON.parse(result.stdout));
		expect(report.sections.some((section) => section.name === "extension:memory" && section.bytes > 0)).toBe(true);
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
	});

	it("inspects a resolved model without requiring credentials", async () => {
		// Given / When
		const result = await runSizes({ noKey: true });
		// Then
		expect(result.code, result.stderr).toBe(0);
		const report = z.object({ total: z.object({ bytes: z.number() }) }).parse(JSON.parse(result.stdout));
		expect(report.total.bytes).toBeGreaterThan(0);
		expect(result.network).toBe("");
	});
});
