/**
 * Regression: an uncaught crash must leave evidence in the brand debug log.
 *
 * `uncaughtCrash` restores the real stderr and prints the banner to the terminal,
 * so before this change a crash existed only in terminal scrollback. A user who
 * closed the terminal (or whose crash was an EIO on that very terminal) left the
 * diagnosis with zero log evidence. The crash entry must therefore be appended to
 * the brand debug log BEFORE `restoreInteractiveStderr()`, redacted, and never be
 * able to alter the crash path itself.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../../../src/config.ts";

const restoreObservations: { debugLogExisted: boolean }[] = vi.hoisted(() => []);

vi.mock("../../../src/modes/interactive/interactive-stderr-guard.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/interactive/interactive-stderr-guard.ts")>();
	const config = await import("../../../src/config.ts");
	const fs = await import("node:fs");
	return {
		...actual,
		restoreInteractiveStderr: () => {
			restoreObservations.push({ debugLogExisted: fs.existsSync(config.getDebugLogPath()) });
			actual.restoreInteractiveStderr();
		},
	};
});

const { InteractiveMode } = await import("../../../src/modes/interactive/interactive-mode.ts");

type UncaughtExceptionOrigin = "uncaughtException" | "unhandledRejection";

type UncaughtCrashThis = {
	isShuttingDown: boolean;
	showWarning: (message: string) => void;
	ui: { stop: () => void };
	unregisterSignalHandlers: () => void;
};

type InteractiveModePrototypeWithUncaughtCrash = {
	uncaughtCrash(this: UncaughtCrashThis, error: Error, origin: UncaughtExceptionOrigin): void;
};

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeWithUncaughtCrash;

function createCrashContext(): UncaughtCrashThis {
	return {
		isShuttingDown: false,
		showWarning: vi.fn(),
		ui: { stop: vi.fn() },
		unregisterSignalHandlers: vi.fn(),
	};
}

/**
 * A crash context that inherits the real prototype, so `this.emergencyTerminalExit()`
 * resolves to the production method instead of a stub. The sibling suite in
 * `terminal-detach-uncaught-crash.test.ts` stubs it deliberately (it pins the routing
 * decision); here the point is what the real emergency exit does, so only the
 * collaborators are faked.
 */
function createRealPrototypeCrashContext(): UncaughtCrashThis {
	const context = Object.create(InteractiveMode.prototype) as UncaughtCrashThis;
	context.isShuttingDown = false;
	context.showWarning = vi.fn();
	context.ui = { stop: vi.fn() };
	context.unregisterSignalHandlers = vi.fn();
	return context;
}

function createDeadTerminalError(shape: "errno-string" | "errno-number"): Error {
	return shape === "errno-string"
		? Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", errno: -5, syscall: "read" })
		: Object.assign(new Error("read failed with errno: 5"), { errno: 5 });
}

/** Drives the dead-terminal route and asserts it still ends in the silent `process.exit(129)`. */
function crashAndExpectEmergencyExit(context: UncaughtCrashThis, error: Error): { bannerCalls: number } {
	const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ProcessExitError(code);
	});
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(() => interactiveModePrototype.uncaughtCrash.call(context, error, "uncaughtException")).toThrow(
			ProcessExitError,
		);
		expect(exit).toHaveBeenCalledWith(129);
		expect(exit).not.toHaveBeenCalledWith(1);
		return {
			bannerCalls: consoleError.mock.calls.filter((args) =>
				args.some((arg) => typeof arg === "string" && arg.includes("exiting due to uncaughtException")),
			).length,
		};
	} finally {
		consoleError.mockRestore();
		exit.mockRestore();
	}
}

const originalAgentDir = process.env[ENV_AGENT_DIR];
const tempDirs: string[] = [];

function useTempAgentDir(slug: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), `senpi-crash-log-${slug}-`));
	tempDirs.push(agentDir);
	process.env[ENV_AGENT_DIR] = agentDir;
	return agentDir;
}

/** Drives the fatal path and asserts it still ends in `process.exit(1)`. */
function crashAndExpectExit(context: UncaughtCrashThis, error: Error, origin: UncaughtExceptionOrigin): void {
	const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ProcessExitError(code);
	});
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(() => interactiveModePrototype.uncaughtCrash.call(context, error, origin)).toThrow(ProcessExitError);
		expect(exit).toHaveBeenCalledWith(1);
		expect(consoleError).toHaveBeenCalled();
	} finally {
		consoleError.mockRestore();
		exit.mockRestore();
	}
}

beforeEach(() => {
	restoreObservations.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("uncaught crash debug log", () => {
	test("records origin and error in the brand debug log before restoring stderr", () => {
		useTempAgentDir("write");
		const error = new Error("extension exploded after boot");
		error.stack = `Error: extension exploded after boot\n    at qaExtension (/tmp/qa-extension.ts:3:9)`;

		crashAndExpectExit(createCrashContext(), error, "uncaughtException");

		const debugLogPath = getDebugLogPath();
		const log = readFileSync(debugLogPath, "utf8");
		expect(log).toContain("uncaught crash (uncaughtException)");
		expect(log).not.toContain("hidden stdout while TUI active");
		expect(log).toContain("extension exploded after boot");
		expect(log).toContain("at qaExtension (/tmp/qa-extension.ts:3:9)");
		expect((statSync(debugLogPath).mode & 0o777).toString(8)).toBe("600");
		// The write must land before the terminal handoff, otherwise a crash that is
		// itself an stderr failure loses its own record.
		expect(restoreObservations).toEqual([{ debugLogExisted: true }]);
	});

	test("records the unhandledRejection origin", () => {
		useTempAgentDir("origin");

		crashAndExpectExit(createCrashContext(), new Error("rejected late"), "unhandledRejection");

		expect(readFileSync(getDebugLogPath(), "utf8")).toContain("uncaught crash (unhandledRejection)");
	});

	test("redacts secret-shaped text before it reaches the debug log", () => {
		useTempAgentDir("redact");
		const error = new Error("request failed: Authorization: Bearer crash-secret-value");
		error.stack = `${error.message}\n    at send (/tmp/send.ts:1:1) OPENAI_API_KEY=crash-secret-key`;

		crashAndExpectExit(createCrashContext(), error, "uncaughtException");

		const log = readFileSync(getDebugLogPath(), "utf8");
		expect(log).toContain("Authorization: Bearer [REDACTED]");
		expect(log).toContain("OPENAI_API_KEY=[REDACTED]");
		expect(log).not.toContain("crash-secret-value");
		expect(log).not.toContain("crash-secret-key");
	});

	test("keeps the normal crash path when the debug log write fails", () => {
		const agentDir = useTempAgentDir("failure");
		// Make the debug log path unwritable by turning it into a directory.
		mkdirSync(getDebugLogPath(), { recursive: true });
		const context = createCrashContext();

		crashAndExpectExit(context, new Error("crash with broken log"), "uncaughtException");

		expect(context.ui.stop).toHaveBeenCalled();
		expect(context.unregisterSignalHandlers).toHaveBeenCalled();
		expect(context.isShuttingDown).toBe(true);
		expect(restoreObservations).toHaveLength(1);
		expect(existsSync(agentDir)).toBe(true);
	});
});

/**
 * The dead-terminal class is the one the debug log matters most for:
 * `emergencyTerminalExit()` exits 129 with no banner precisely because the terminal
 * is gone, so the log file is the ONLY surface a crash record can reach. Without
 * these cases the EIO crash that motivated this change still vanishes silently.
 */
describe("dead-terminal crash debug log", () => {
	test("records a dead-terminal crash routed to the silent emergency exit", () => {
		useTempAgentDir("dead-terminal");
		const context = createRealPrototypeCrashContext();

		const { bannerCalls } = crashAndExpectEmergencyExit(context, createDeadTerminalError("errno-string"));

		const debugLogPath = getDebugLogPath();
		const log = readFileSync(debugLogPath, "utf8");
		expect(log).toContain("uncaught crash (dead-terminal uncaughtException)");
		expect(log).toContain("EIO: i/o error, read");
		expect((statSync(debugLogPath).mode & 0o777).toString(8)).toBe("600");
		// The silent contract from the dead-terminal routing must survive: the record
		// goes to the log, never to a terminal that is already gone.
		expect(bannerCalls).toBe(0);
		expect(context.ui.stop).not.toHaveBeenCalled();
		expect(context.unregisterSignalHandlers).toHaveBeenCalledTimes(1);
		expect(context.isShuttingDown).toBe(true);
		expect(restoreObservations).toEqual([]);
	});

	test("records the Bun numeric-errno dead-terminal shape too", () => {
		useTempAgentDir("dead-terminal-bun");

		crashAndExpectEmergencyExit(createRealPrototypeCrashContext(), createDeadTerminalError("errno-number"));

		const log = readFileSync(getDebugLogPath(), "utf8");
		expect(log).toContain("uncaught crash (dead-terminal uncaughtException)");
		expect(log).toContain("read failed with errno: 5");
	});

	test("keeps the silent emergency exit unchanged when the debug log write fails", () => {
		useTempAgentDir("dead-terminal-failure");
		// Make the debug log path unwritable by turning it into a directory.
		mkdirSync(getDebugLogPath(), { recursive: true });
		const context = createRealPrototypeCrashContext();

		const { bannerCalls } = crashAndExpectEmergencyExit(context, createDeadTerminalError("errno-string"));

		expect(bannerCalls).toBe(0);
		expect(context.unregisterSignalHandlers).toHaveBeenCalledTimes(1);
		expect(context.isShuttingDown).toBe(true);
	});
});
