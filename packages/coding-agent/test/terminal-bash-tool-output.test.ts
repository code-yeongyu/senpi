import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/core/extensions/builtin/terminal/manager.ts";
import { TERMINAL_TOOL_MAX_BYTES } from "../src/core/extensions/builtin/terminal/output-format.ts";
import { createPtyBashTool } from "../src/core/extensions/builtin/terminal/tools/bash.ts";
import type { TerminalToolContext, TerminalToolResult } from "../src/core/extensions/builtin/terminal/tools/context.ts";

/**
 * Model-facing output of the PTY bash tool must be bounded and sanitized:
 * raw 1 MB scrollback dumps and ANSI spinner floods used to go straight into
 * the conversation, instantly blowing the context past the compaction
 * threshold. Foreground spawns also inject a non-interactive environment
 * (NO_COLOR / TERM=dumb / cat pagers) so cooperative tools never emit the
 * escape soup in the first place; background interactive sessions keep the
 * user's real TERM.
 */

function resultText(result: TerminalToolResult): string {
	return result.content.map((block) => block.text).join("\n");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => reject(new Error(`${label}: did not settle within ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

function nodeEval(script: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe.skipIf(process.platform === "win32")("PTY bash tool model-facing output", () => {
	let testDir: string;
	let manager: TerminalManager;
	let ctx: TerminalToolContext;

	beforeEach(() => {
		testDir = join(tmpdir(), `senpi-pty-output-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		manager = new TerminalManager();
		ctx = {
			manager,
			cwd: testDir,
			defaultCols: 80,
			defaultRows: 24,
			getEnv: () => ({ ...process.env }),
		};
	});

	afterEach(async () => {
		await withTimeout(manager.teardown(), 15000, "manager teardown");
		rmSync(testDir, { recursive: true, force: true });
	});

	it("bounds a huge foreground result instead of dumping the full scrollback", async () => {
		const tool = createPtyBashTool(ctx);
		const script = `process.stdout.write("y".repeat(${TERMINAL_TOOL_MAX_BYTES * 4}))`;
		const result = await withTimeout(
			tool.execute("call-big", { command: nodeEval(script) }, undefined, undefined, undefined),
			30000,
			"huge foreground command",
		);
		const text = resultText(result);
		expect(text.length).toBeLessThan(TERMINAL_TOOL_MAX_BYTES * 2);
		expect(text).toContain("earlier output dropped");
	});

	it("strips ANSI sequences and collapses spinner frames in foreground results", async () => {
		const tool = createPtyBashTool(ctx);
		const frame = `\\r\\x1b[K\\x1b[36m⣾\\x1b[0m`;
		const script = `process.stdout.write("${frame}".repeat(2000) + "\\r\\x1b[K\\x1b[32m✓\\x1b[0m finished\\n")`;
		const result = await withTimeout(
			tool.execute("call-ansi", { command: nodeEval(script) }, undefined, undefined, undefined),
			30000,
			"spinner command",
		);
		const text = resultText(result);
		expect(text).toContain("✓ finished");
		expect(text).not.toContain("\x1b[");
		expect(text.length).toBeLessThan(2000);
	});

	it("injects a non-interactive environment for foreground commands", async () => {
		const tool = createPtyBashTool({ ...ctx, getEnv: () => ({ ...process.env, TERM: "xterm-256color" }) });
		const result = await withTimeout(
			tool.execute(
				"call-env",
				{ command: 'printf \'%s|%s|%s|%s\' "$NO_COLOR" "$TERM" "$PAGER" "$GH_PAGER"' },
				undefined,
				undefined,
				undefined,
			),
			30000,
			"env probe",
		);
		expect(resultText(result)).toContain("1|dumb|cat|cat");
	});

	it("does not inject the non-interactive environment into background sessions", async () => {
		const tool = createPtyBashTool({ ...ctx, getEnv: () => ({ ...process.env, TERM: "xterm-256color" }) });
		const result = await withTimeout(
			tool.execute(
				"call-bg",
				{ command: "printf 'TERM=%s\n' \"$TERM\"", run_in_background: true },
				undefined,
				undefined,
				undefined,
			),
			30000,
			"background env probe",
		);
		expect(resultText(result)).toContain("TERM=xterm-256color");
	});
});
