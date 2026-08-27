import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type UncaughtExceptionOrigin = "uncaughtException" | "unhandledRejection";

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

type UncaughtCrashThis = {
	isShuttingDown: boolean;
	showWarning: (message: string) => void;
	ui: { stop: () => void };
	unregisterSignalHandlers: () => void;
	emergencyTerminalExit: () => never;
};

type InteractiveModePrototypeWithUncaughtCrash = {
	uncaughtCrash(this: UncaughtCrashThis, error: Error, origin: UncaughtExceptionOrigin): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeWithUncaughtCrash;

function callUncaughtCrash(context: UncaughtCrashThis, error: Error, origin: UncaughtExceptionOrigin): void {
	interactiveModePrototype.uncaughtCrash.call(context, error, origin);
}

function createCrashContext(): UncaughtCrashThis {
	return {
		isShuttingDown: false,
		showWarning: vi.fn(),
		ui: { stop: vi.fn() },
		unregisterSignalHandlers: vi.fn(),
		emergencyTerminalExit: vi.fn(() => {
			throw new ProcessExitError(129);
		}) as unknown as () => never,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("uncaughtCrash dead-terminal classification", () => {
	test("routes a stdin read EIO to the silent emergency exit instead of the crash banner", () => {
		// Given a running session whose controlling terminal vanished under it.
		const context = createCrashContext();
		const eio = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", errno: -5, syscall: "read" });
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		// When the unlistened stdin error reaches the last-resort handler.
		expect(() => callUncaughtCrash(context, eio, "uncaughtException")).toThrow(ProcessExitError);

		// Then the dead-terminal path wins: silent 129, no banner, no fatal exit(1).
		expect(context.emergencyTerminalExit).toHaveBeenCalledTimes(1);
		expect(exit).not.toHaveBeenCalled();
		expect(context.ui.stop).not.toHaveBeenCalled();
		const bannerCalls = consoleError.mock.calls.filter((args) =>
			args.some((arg) => typeof arg === "string" && arg.includes("exiting due to uncaughtException")),
		);
		expect(bannerCalls).toHaveLength(0);
	});

	test("routes Bun's numeric-errno dead-terminal shape to the emergency exit", () => {
		// Given the same detach reported as a bare numeric errno (Bun macOS shape).
		const context = createCrashContext();
		const eio = Object.assign(new Error("read failed with errno: 5"), { errno: 5 });
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// When / Then
		expect(() => callUncaughtCrash(context, eio, "uncaughtException")).toThrow(ProcessExitError);
		expect(context.emergencyTerminalExit).toHaveBeenCalledTimes(1);
	});

	test("keeps ordinary crashes on the fatal banner path", () => {
		// Given a crash that has nothing to do with a dead terminal.
		const context = createCrashContext();
		const failure = Object.assign(new Error("unexpected extension failure"), { code: "EINVAL" });
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		// When
		expect(() => callUncaughtCrash(context, failure, "uncaughtException")).toThrow(ProcessExitError);

		// Then the existing contract is untouched: banner, terminal restore, exit(1).
		expect(exit).toHaveBeenCalledWith(1);
		expect(context.emergencyTerminalExit).not.toHaveBeenCalled();
		expect(context.ui.stop).toHaveBeenCalledTimes(1);
		const bannerCalls = consoleError.mock.calls.filter((args) =>
			args.some((arg) => typeof arg === "string" && arg.includes("exiting due to uncaughtException")),
		);
		expect(bannerCalls.length).toBeGreaterThan(0);
	});

	test("stays silent when the dead-terminal error arrives mid-shutdown", () => {
		// Given shutdown already latched (its own EIO handling owns the terminal).
		const context = createCrashContext();
		context.isShuttingDown = true;
		const eio = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		// When
		expect(() => callUncaughtCrash(context, eio, "uncaughtException")).toThrow(ProcessExitError);

		// Then the established silent exit(1) is preserved, no double teardown.
		expect(exit).toHaveBeenCalledWith(1);
		expect(context.emergencyTerminalExit).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});
});
