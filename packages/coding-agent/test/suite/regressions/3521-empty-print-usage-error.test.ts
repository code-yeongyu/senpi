import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { buildInitialMessage, hasPrintInput } from "../../../src/cli/initial-message.ts";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const EMPTY_PRINT = "Error: print mode needs a prompt.";
const sandboxes: string[] = [];
afterAll(() => {
	for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function printInput(argv: string[], stdinContent?: string): boolean {
	const parsed = parseArgs(argv);
	return hasPrintInput(buildInitialMessage({ parsed, stdinContent }), parsed.messages);
}

async function runCli(argv: string[], stdin = "") {
	const sandbox = mkdtempSync(join(tmpdir(), "3521-cli-"));
	sandboxes.push(sandbox);
	const agentDir = join(sandbox, "agent");
	mkdirSync(agentDir);
	const models = join(agentDir, "models.json");
	writeFileSync(
		models,
		JSON.stringify({
			providers: {
				"print-fixture": {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:1",
					apiKey: "synthetic-print-key",
					models: [{ id: "fixture", name: "Fixture", contextWindow: 128000, maxTokens: 4096 }],
				},
			},
		}),
	);
	const modelConfigRead = join(sandbox, "model-config-read");
	const probe = join(sandbox, "probe.mjs");
	writeFileSync(
		probe,
		`
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const markModelRead = (path) => {
	if (path === ${JSON.stringify(models)}) fs.writeFileSync(${JSON.stringify(modelConfigRead)}, "");
};
const readFile = fsp.readFile;
fsp.readFile = (path, ...args) => {
	markModelRead(path);
	return readFile(path, ...args);
};
const readFileSync = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
	markModelRead(path);
	return readFileSync(path, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("Network forbidden in #3521 regression"); };
`,
	);
	const extension = join(sandbox, "capture-input.mjs");
	writeFileSync(
		extension,
		`
export default (pi) => {
	pi.on("input", (event, ctx) => {
		console.error("captured:", ctx.model?.provider, ctx.model?.id, event.text);
		return { action: "handled" };
	});
};
`,
	);
	writeFileSync(join(sandbox, "context.txt"), "from attachment");
	const child = spawn(
		process.execPath,
		[
			"--import",
			join(root, "node_modules/tsx/dist/loader.mjs"),
			"--import",
			probe,
			join(root, "packages/coding-agent/src/cli.ts"),
			"--no-session",
			"--provider",
			"print-fixture",
			"--model",
			"fixture",
			"--extension",
			extension,
			...argv,
		],
		{
			cwd: sandbox,
			env: {
				PATH: process.env.PATH,
				HOME: sandbox,
				SENPI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
			},
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 25_000,
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.stdin.once("error", reject);
		child.once("close", resolve);
		child.stdin.end(stdin);
	});
	return { code, stdout, stderr, readModelConfig: existsSync(modelConfigRead) };
}

describe("an empty print run fails with a usage error (senpi#3521)", () => {
	it.each([[["-p"]], [["-p", ""]], [["--mode", "json", "-p"]], [["-p", "--no-model-fallback"]]])(
		"%j rejects empty input before model startup",
		async (argv) => {
			const run = await runCli(argv);

			expect(run.code).toBe(1);
			expect(run.stderr).toContain(EMPTY_PRINT);
			expect(run.stdout).toBe("");
			expect(run.readModelConfig, "empty input reached model runtime initialization").toBe(false);
		},
	);

	it.each([
		{ argv: ["-p", "--no-model-fallback", "hello"], input: "hello" },
		{ argv: ["-p"], stdin: "from stdin", input: "from stdin" },
		{ argv: ["-p", "@context.txt"], input: "from attachment" },
	])("admits the synthetic model and delivers input for $argv", async ({ argv, stdin, input }) => {
		const run = await runCli(argv, stdin);

		expect(run.stderr).not.toContain(EMPTY_PRINT);
		expect(run.stderr).toMatch(new RegExp(`captured: print-fixture fixture [\\s\\S]*${input}`));
		expect(run.code).toBe(0);
		expect(run.readModelConfig).toBe(true);
	});

	it("counts a positional prompt, piped stdin, @file images and later messages as input", () => {
		expect(printInput(["-p", "hello"])).toBe(true);
		expect(printInput(["-p"], "from stdin")).toBe(true);
		expect(printInput(["-p", "", "second"])).toBe(true);
		expect(hasPrintInput({ initialImages: [{ type: "image", mimeType: "image/png", data: "AA==" }] }, [])).toBe(true);
		expect(printInput(["-p"])).toBe(false);
		expect(printInput(["-p"], "")).toBe(false);
	});
});
