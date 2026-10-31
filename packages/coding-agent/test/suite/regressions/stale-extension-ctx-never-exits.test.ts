/**
 * Regression (oh-my-openagent#7114): a retired extension generation that touches its old ctx from a
 * timer throws the stale guard synchronously, which reached `uncaughtException` and exited the TUI
 * mid-task. The guard throws before the operation runs, so the live session must keep running.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../../../src/config.ts";
import { containStaleExtensionError } from "../../../src/core/stale-extension-containment.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

type Origin = "uncaughtException" | "unhandledRejection";
type CrashThis = {
	isShuttingDown: boolean;
	showWarning: (message: string) => void;
	ui: { stop: () => void };
	pauseQuestionMouseCapture: () => void;
	unregisterSignalHandlers: () => void;
};
const crashPrototype = InteractiveMode.prototype as unknown as {
	uncaughtCrash(this: CrashThis, error: Error, origin: Origin): void;
};

function staleErrorFromTimer(message = STALE_MESSAGE): Error {
	const error = new Error(message);
	error.stack = `Error: ${message}\n    at Object.get ui (runner.ts:1231:12)\n    at Timeout.tick (memory/status-live.ts:64:5)`;
	return error;
}

const originalAgentDir = process.env[ENV_AGENT_DIR];
const tempDirs: string[] = [];
function useTempAgentDir(): void {
	const dir = mkdtempSync(join(tmpdir(), "senpi-stale-ctx-"));
	tempDirs.push(dir);
	process.env[ENV_AGENT_DIR] = dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a retired extension ctx never ends the session", () => {
	for (const [label, message] of [
		["session replacement", STALE_MESSAGE],
		["reload", "stale extension generation after reload"],
	] as const) {
		test(`the interactive crash handler keeps running after a stale ctx throw from a timer (${label})`, () => {
			useTempAgentDir();
			const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
				throw new Error(`process.exit(${String(code)})`);
			});
			const context: CrashThis = {
				isShuttingDown: false,
				showWarning: vi.fn(),
				ui: { stop: vi.fn() },
				pauseQuestionMouseCapture: vi.fn(),
				unregisterSignalHandlers: vi.fn(),
			};

			crashPrototype.uncaughtCrash.call(context, staleErrorFromTimer(message), "uncaughtException");

			expect(exit).not.toHaveBeenCalled();
			expect(context.isShuttingDown).toBe(false);
			expect(context.ui.stop).not.toHaveBeenCalled();
			expect(readFileSync(getDebugLogPath(), "utf8")).toContain("memory/status-live.ts:64:5");
		});
	}

	test("the process-level seam swallows only stale ctx errors and logs where they came from", () => {
		useTempAgentDir();

		expect(containStaleExtensionError(staleErrorFromTimer(), "uncaughtException")).toBe(true);
		expect(containStaleExtensionError(new Error("real bug"), "uncaughtException")).toBe(false);
		expect(containStaleExtensionError("not an error", "unhandledRejection")).toBe(false);
		expect(readFileSync(getDebugLogPath(), "utf8")).toContain("memory/status-live.ts:64:5");
	});

	const child = join(import.meta.dirname, "../../fixtures/stale-ctx-crash-child.ts");
	const runtimes = [
		["bun", ["bun", child]],
		["node", ["node", "--import", "tsx", child]],
	] as const;
	for (const [runtime, [command, ...prefix]] of runtimes) {
		for (const recoverInspector of [false, true]) {
			const label = `${runtime}${recoverInspector ? " with SENPI_RECOVER_INSPECTOR_VM_IMPORT=1" : ""}`;
			const run = (scenario: string) => {
				const agentDir = mkdtempSync(join(tmpdir(), "senpi-stale-child-"));
				tempDirs.push(agentDir);
				const env: NodeJS.ProcessEnv = { ...process.env, [ENV_AGENT_DIR]: agentDir };
				if (recoverInspector) env.SENPI_RECOVER_INSPECTOR_VM_IMPORT = "1";
				else delete env.SENPI_RECOVER_INSPECTOR_VM_IMPORT;
				return spawnSync(command, [...prefix, scenario], { env, encoding: "utf8", timeout: 60_000 });
			};
			// Bun never routes an unhandled rejection to `uncaughtException`, and containment deliberately adds no
			// `unhandledRejection` listener (it would change every rejection's default), so under Bun only the
			// synchronous throw is contained headless; the TUI's own rejection handler already logs and continues.
			for (const scenario of runtime === "node" ? ["stale-sync", "stale-async"] : ["stale-sync"]) {
				test(`a headless ${label} process keeps running after a ${scenario} stale ctx throw`, () => {
					const result = run(scenario);
					expect(result.status, result.stderr).toBe(0);
					expect(result.stdout).toContain("STILL ALIVE");
				});
			}
			for (const scenario of ["real-sync", "real-async"]) {
				test(`a headless ${label} process still exits 1 on a ${scenario} real crash`, () => {
					const result = run(scenario);
					expect(result.status).toBe(1);
					expect(result.stdout).not.toContain("STILL ALIVE");
					expect(result.stderr).toContain("real bug");
				});
			}
		}
	}

	test("a real bug still exits the interactive session", () => {
		useTempAgentDir();
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${String(code)})`);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const context: CrashThis = {
			isShuttingDown: false,
			showWarning: vi.fn(),
			ui: { stop: vi.fn() },
			pauseQuestionMouseCapture: vi.fn(),
			unregisterSignalHandlers: vi.fn(),
		};

		expect(() => crashPrototype.uncaughtCrash.call(context, new Error("real bug"), "uncaughtException")).toThrow(
			"process.exit(1)",
		);
		expect(exit).toHaveBeenCalledWith(1);
	});
});
