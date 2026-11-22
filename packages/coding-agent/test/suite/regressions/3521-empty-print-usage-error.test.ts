import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

async function runCli(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const sandbox = mkdtempSync(join(tmpdir(), "3521-cli-"));
	sandboxes.push(sandbox);
	const agentDir = join(sandbox, "agent");
	mkdirSync(agentDir);
	const child = spawn(
		process.execPath,
		[
			join(root, "node_modules/tsx/dist/cli.mjs"),
			"--tsconfig",
			join(root, "tsconfig.json"),
			join(root, "packages/coding-agent/src/cli.ts"),
			...argv,
		],
		{
			cwd: sandbox,
			env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir, HOME: sandbox, PI_OFFLINE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
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
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	return { code, stdout, stderr };
}

describe("an empty print run fails with a usage error (senpi#3521)", () => {
	it.each([[["-p"]], [["-p", ""]], [["--mode", "json", "-p"]], [["-p", "--no-model-fallback"]]])(
		"%j exits 1 and says a prompt is needed",
		async (argv) => {
			const run = await runCli(argv);

			expect(run.code).toBe(1);
			expect(run.stderr).toContain(EMPTY_PRINT);
			expect(run.stdout).toBe("");
		},
		60_000,
	);

	it("still hands a prompt after a boolean flag to the model (control)", async () => {
		const run = await runCli(["-p", "--no-model-fallback", "hello"]);

		expect(run.stderr).not.toContain(EMPTY_PRINT);
		expect(run.stderr).toContain("No API key found");
	}, 60_000);

	it("counts a positional prompt, piped stdin, @file images and later messages as input", () => {
		expect(printInput(["-p", "hello"])).toBe(true);
		expect(printInput(["-p"], "from stdin")).toBe(true);
		expect(printInput(["-p", "", "second"])).toBe(true);
		expect(hasPrintInput({ initialImages: [{ type: "image", mimeType: "image/png", data: "AA==" }] }, [])).toBe(true);
		expect(printInput(["-p"])).toBe(false);
		expect(printInput(["-p"], "")).toBe(false);
	});
});
