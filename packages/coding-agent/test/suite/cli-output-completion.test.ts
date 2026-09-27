import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsx = import.meta.resolve("tsx/esm");

async function captureCommand(cwd: string, args: string[], outputFile?: string): Promise<string> {
	const outputFd = outputFile === undefined ? undefined : openSync(outputFile, "w");
	const child = spawn(process.execPath, ["--import", tsx, cli, ...args], {
		cwd,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: cwd,
			USERPROFILE: cwd,
			XDG_CONFIG_HOME: join(cwd, "config"),
			SENPI_CODING_AGENT_DIR: join(cwd, "agent"),
			SENPI_CODING_AGENT_SESSION_DIR: join(cwd, "sessions"),
			SENPI_RUNTIME: "node",
			PI_OFFLINE: "1",
			PI_SKIP_RUNTIME_NOTICE: "1",
			NO_COLOR: "1",
		},
		stdio: ["ignore", outputFd ?? "pipe", "pipe"],
		signal: AbortSignal.timeout(20_000),
	});
	let stdout = "";
	let stderr = "";
	let readerDelay: ReturnType<typeof setTimeout> | undefined;
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	// This is OS pipe backpressure, not a timer-based application assertion. A slow consumer must
	// receive the same bytes as a regular file even when the command finishes producing its table.
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stdout?.pause();
	child.stdout?.once("readable", () => {
		readerDelay = setTimeout(() => {
			child.stdout?.resume();
		}, 100);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else reject(new Error(`CLI exited ${code ?? signal}: ${stderr}`));
			});
		});
		return outputFile === undefined ? stdout : readFileSync(outputFile, "utf8");
	} finally {
		if (readerDelay !== undefined) clearTimeout(readerDelay);
		if (outputFd !== undefined) closeSync(outputFd);
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}

describe("CLI output completion", () => {
	it("preserves the complete offline catalog for concurrent slow pipe consumers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-catalog-output-"));
		try {
			const extension = join(dir, "catalog-extension.ts");
			// Keep later builtin providers beyond OS pipe capacity without relying on catalog growth.
			writeFileSync(
				extension,
				`export default (pi) => pi.registerProvider("aaa-catalog-fixture", {
				baseUrl: "https://example.invalid/v1", apiKey: "faux-key", api: "openai-completions",
				models: Array.from({ length: 4096 }, (_, i) => ({
					id: "padding-" + String(i).padStart(4, "0"), name: "Offline catalog fixture",
					reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
				}))
			});`,
			);
			const args = [
				"--no-extensions",
				"--extension",
				extension,
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--list-models",
			];
			const complete = await captureCommand(dir, args, join(dir, "catalog.txt"));
			expect(complete.length).toBeGreaterThan(65_536);
			expect(complete).toMatch(/^openrouter\s+deepseek\/deepseek-v4\.1-flash\s/m);
			const outputs = await Promise.all(
				Array.from({ length: 3 }, async (_, i) => {
					const cwd = join(dir, String(i));
					mkdirSync(cwd);
					return captureCommand(cwd, args);
				}),
			);
			for (const output of outputs) {
				expect(output.length).toBe(complete.length);
				expect(output).toBe(complete);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("preserves cold and cached help through a slow pipe", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-help-output-"));
		try {
			const args = ["--help"];
			const complete = await captureCommand(dir, args, join(dir, "help.txt"));
			expect(complete.length).toBeGreaterThan(8_192);
			const coldDir = join(dir, "cold");
			mkdirSync(coldDir);
			expect(await captureCommand(coldDir, args)).toBe(complete);
			expect(await captureCommand(coldDir, args)).toBe(complete);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
