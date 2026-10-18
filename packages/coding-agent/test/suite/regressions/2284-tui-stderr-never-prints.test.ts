/**
 * Regression #2284: while the interactive TUI owns the terminal, no runtime error output may
 * reach the screen. Under Bun a floating rejection never reaches `uncaughtException`; Bun
 * printed its native dump to fd 2 (the terminal) and nothing was logged. Worker `console.*`
 * and children inheriting stderr also wrote fd 2 directly, past the JS-level guard.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../../../src/config.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

type SignalHandlerContext = {
	signalCleanupHandlers: (() => void)[];
	ui: { terminal: { columns: number }; stop: () => void };
	showWarning: (message: string) => void;
	isShuttingDown: boolean;
	pauseQuestionMouseCapture: () => void;
};

type CrashContext = {
	isShuttingDown: boolean;
	showWarning: (message: string) => void;
	ui: { stop: () => void };
	pauseQuestionMouseCapture: () => void;
	unregisterSignalHandlers: () => void;
};

type InteractiveModeInternals = {
	registerSignalHandlers(this: SignalHandlerContext): void;
	unregisterSignalHandlers(this: SignalHandlerContext): void;
	uncaughtCrash(this: CrashContext, error: Error, origin: "uncaughtException" | "unhandledRejection"): void;
};

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

const internals = InteractiveMode.prototype as unknown as InteractiveModeInternals;
const guardModule = fileURLToPath(
	new URL("../../../src/modes/interactive/interactive-stderr-guard.ts", import.meta.url),
);
const originalAgentDir = process.env[ENV_AGENT_DIR];
const tempDirs: string[] = [];

function useTempAgentDir(slug: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), `senpi-2284-${slug}-`));
	tempDirs.push(agentDir);
	process.env[ENV_AGENT_DIR] = agentDir;
	return agentDir;
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("#2284 unhandled rejection while the TUI owns the terminal", () => {
	test("is recorded in the debug log, never printed, and the session keeps running", () => {
		useTempAgentDir("rejection");
		const context = Object.assign(Object.create(InteractiveMode.prototype) as SignalHandlerContext, {
			signalCleanupHandlers: [],
			ui: { terminal: { columns: 80 }, stop: vi.fn() },
			showWarning: vi.fn(),
			isShuttingDown: false,
			pauseQuestionMouseCapture: vi.fn(),
		});
		const before = new Set(process.listeners("unhandledRejection"));
		internals.registerSignalHandlers.call(context);
		const added = process.listeners("unhandledRejection").filter((listener) => !before.has(listener));
		try {
			expect(added).toHaveLength(1);
			const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
				throw new ProcessExitError(code);
			});
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
			const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const reason = new Error("Timeout waiting for response to prompt. Stderr: Authorization: Bearer leak-me");
			const rejected = Promise.reject(reason);
			rejected.catch(() => {});

			(added[0] as RejectionListener)(reason, rejected);

			expect(exit).not.toHaveBeenCalled();
			expect(consoleError).not.toHaveBeenCalled();
			expect(stderrWrite).not.toHaveBeenCalled();
			expect(context.ui.stop).not.toHaveBeenCalled();
			expect(context.isShuttingDown).toBe(false);
			const log = readFileSync(getDebugLogPath(), "utf8");
			expect(log).toContain("unhandled rejection");
			expect(log).toContain("Timeout waiting for response to prompt");
			expect(log).toContain("Authorization: Bearer [REDACTED]");
			expect(log).not.toContain("leak-me");
		} finally {
			internals.unregisterSignalHandlers.call(context);
		}
		expect(process.listeners("unhandledRejection").filter((listener) => !before.has(listener))).toHaveLength(0);
	});
});

describe("#2284 fatal crash banner", () => {
	function crash(error: Error): string[] {
		const context: CrashContext = {
			isShuttingDown: false,
			showWarning: vi.fn(),
			ui: { stop: vi.fn() },
			pauseQuestionMouseCapture: vi.fn(),
			unregisterSignalHandlers: vi.fn(),
		};
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => internals.uncaughtCrash.call(context, error, "uncaughtException")).toThrow(ProcessExitError);
		return consoleError.mock.calls.map((args) =>
			args.map((arg) => (arg instanceof Error ? (arg.stack ?? String(arg)) : String(arg))).join(" "),
		);
	}

	function crashError(): Error {
		const error = new Error("extension exploded after boot");
		error.stack = "Error: extension exploded after boot\n    at qaExtension (/tmp/qa-extension.ts:3:9)";
		return error;
	}

	test("prints one readable line plus the debug log path, not the stack", () => {
		useTempAgentDir("banner");
		const printed = crash(crashError());

		expect(printed.join("\n")).toContain("extension exploded after boot");
		expect(printed.join("\n")).toContain(getDebugLogPath());
		expect(printed.join("\n")).not.toContain("at qaExtension");
		for (const line of printed) expect(line).not.toContain("\n");
		expect(readFileSync(getDebugLogPath(), "utf8")).toContain("at qaExtension");
	});

	test("still prints the full error when the debug log cannot be written", () => {
		useTempAgentDir("banner-fallback");
		mkdirSync(getDebugLogPath(), { recursive: true });

		expect(crash(crashError()).join("\n")).toContain("at qaExtension");
	});
});

describe.skipIf(process.platform === "win32")("#2284 fd-level stderr capture under Bun", () => {
	test("Worker console, inherited-stderr children, and raw fd 2 writes go to the debug log until restore", () => {
		const agentDir = useTempAgentDir("fd");
		const workerPath = join(agentDir, "worker.ts");
		const fixturePath = join(agentDir, "fixture.ts");
		writeFileSync(workerPath, 'console.error(new Error("worker-line")); postMessage("done");\n');
		writeFileSync(
			fixturePath,
			[
				"import { writeSync } from 'node:fs';",
				`import { prepareInteractiveStderrCapture, restoreInteractiveStderr, takeOverInteractiveStderr } from ${JSON.stringify(guardModule)};`,
				"await prepareInteractiveStderrCapture();",
				"takeOverInteractiveStderr();",
				`const worker = new Worker(${JSON.stringify(workerPath)});`,
				"await new Promise((resolve) => { worker.onmessage = resolve; });",
				"await worker.terminate();",
				"await Bun.spawn(['/bin/sh', '-c', 'echo child-line >&2'], { stdout: 'ignore', stderr: 'inherit' }).exited;",
				"writeSync(2, 'native-line\\n');",
				"restoreInteractiveStderr();",
				"writeSync(2, 'after-restore\\n');",
			].join("\n"),
		);

		const result = spawnSync("bun", [fixturePath], {
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toContain("after-restore");
		expect(result.stderr).not.toContain("worker-line");
		expect(result.stderr).not.toContain("child-line");
		expect(result.stderr).not.toContain("native-line");
		const log = readFileSync(getDebugLogPath(), "utf8");
		expect(log).toContain("worker-line");
		expect(log).toContain("child-line");
		expect(log).toContain("native-line");
		expect(log).not.toContain("after-restore");
	});
});
