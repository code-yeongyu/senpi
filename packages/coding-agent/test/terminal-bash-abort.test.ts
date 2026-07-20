import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/core/extensions/builtin/terminal/manager.ts";
import { createPtyBashTool } from "../src/core/extensions/builtin/terminal/tools/bash.ts";
import type { TerminalToolContext, TerminalToolResult } from "../src/core/extensions/builtin/terminal/tools/context.ts";

/**
 * Interrupting the PTY-backed `bash` tool must release the tool promptly.
 *
 * Two production hangs are pinned here:
 * - abort used to send a one-shot group SIGTERM, so a command that survives
 *   SIGTERM kept `waitExit` blocked forever;
 * - even after the shell died, the native wait joins the PTY reader thread,
 *   which blocks while an escaped descendant (own process group, inherited
 *   slave fd) holds the PTY open — ESC appeared dead while "Running bash"
 *   counted up for hours.
 */

const ORPHAN_PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const tickerSrc =
	"const fs=require('node:fs');let first=true;" +
	"setInterval(()=>{console.log('orphan-tick');if(first){first=false;fs.writeFileSync(process.argv[1],'1');}},40);";
const child = spawn(process.execPath, ["-e", tickerSrc, process.argv[2] + ".ticked"], {
	detached: true,
	stdio: ["ignore", "inherit", "ignore"],
});
writeFileSync(process.argv[2], String(child.pid));
child.unref();
console.log("parent-ready");
setInterval(() => {}, 1000);
`;

function toShellSingleQuotedArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resultText(result: TerminalToolResult): string {
	return result.content.map((block) => block.text).join("\n");
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (!existsSync(path)) {
		if (Date.now() - start > timeoutMs) throw new Error(`file did not appear within ${timeoutMs}ms: ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(new Error(`${label}: did not release within ${ms}ms`));
		}, ms);
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

describe.skipIf(process.platform === "win32")("PTY bash tool abort releases the wait", () => {
	let testDir: string;
	let scriptPath: string;
	let manager: TerminalManager;
	let ctx: TerminalToolContext;
	const pidFiles: string[] = [];

	beforeEach(() => {
		testDir = join(tmpdir(), `senpi-pty-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		scriptPath = join(testDir, "orphan-parent.cjs");
		writeFileSync(scriptPath, ORPHAN_PARENT_SCRIPT);
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
		for (const pidFile of pidFiles) {
			if (!existsSync(pidFile)) continue;
			const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (Number.isFinite(pid) && pid > 0) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
		pidFiles.length = 0;
		await withTimeout(manager.teardown(), 15000, "manager teardown");
		rmSync(testDir, { recursive: true, force: true });
	});

	function orphanCommand(pidFile: string): string {
		pidFiles.push(pidFile);
		return `${toShellSingleQuotedArg(process.execPath)} ${toShellSingleQuotedArg(scriptPath)} ${toShellSingleQuotedArg(pidFile)}`;
	}

	it("returns aborted without spawning when the signal is already aborted", async () => {
		const tool = createPtyBashTool(ctx);
		const controller = new AbortController();
		controller.abort();

		const result = await withTimeout(
			tool.execute("call-0", { command: "echo never-runs" }, controller.signal, undefined, undefined),
			5000,
			"pre-aborted execute",
		);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("Command aborted");
		expect(manager.size).toBe(0);
	});

	it("runs a plain command to completion", async () => {
		const tool = createPtyBashTool(ctx);
		const result = await withTimeout(
			tool.execute("call-1", { command: "echo pty-ok" }, undefined, undefined, undefined),
			10000,
			"plain command",
		);
		expect(result.isError).toBeFalsy();
		expect(resultText(result)).toContain("pty-ok");
	});

	it("aborts a command that ignores SIGTERM", async () => {
		const tool = createPtyBashTool(ctx);
		const controller = new AbortController();
		const marker = join(testDir, "trap-ready");
		const command = `trap '' TERM; touch ${toShellSingleQuotedArg(marker)}; while :; do sleep 0.2; done`;

		const execution = tool.execute("call-2", { command }, controller.signal, undefined, undefined);
		await waitForFile(marker, 10000);
		controller.abort();

		const result = await withTimeout(execution, 4000, "abort of SIGTERM-ignoring command");
		expect(resultText(result)).toContain("Command aborted");
	});

	it("aborts within the exit grace while an escaped descendant holds the PTY open", async () => {
		const tool = createPtyBashTool(ctx);
		const controller = new AbortController();
		const pidFile = join(testDir, "orphan-abort.pid");

		const execution = tool.execute(
			"call-3",
			{ command: orphanCommand(pidFile) },
			controller.signal,
			undefined,
			undefined,
		);
		await waitForFile(`${pidFile}.ticked`, 10000);
		controller.abort();

		const result = await withTimeout(execution, 8000, "abort with PTY held open");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("Command aborted");
	});

	it("times out within the exit grace while an escaped descendant holds the PTY open", async () => {
		const tool = createPtyBashTool(ctx);
		const pidFile = join(testDir, "orphan-timeout.pid");

		const execution = tool.execute(
			"call-4",
			{ command: orphanCommand(pidFile), timeout: 1 },
			undefined,
			undefined,
			undefined,
		);

		const result = await withTimeout(execution, 10000, "timeout with PTY held open");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("Command timed out after 1 seconds");
	});
});
