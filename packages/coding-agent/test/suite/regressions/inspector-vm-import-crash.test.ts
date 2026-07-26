import { spawnSync } from "node:child_process";
import { close as closeInspector, url as inspectorUrl, open as openInspector } from "node:inspector";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { isRecoverableInspectorVmImportError } from "../../../src/inspector-policy.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type UncaughtExceptionOrigin = "uncaughtException" | "unhandledRejection";

const originalRecoveryFlag = vi.hoisted(() => {
	const original = process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT;
	process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT = "1";
	return original;
});

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

function callUncaughtCrash(context: UncaughtCrashThis, error: Error, origin: UncaughtExceptionOrigin): void {
	interactiveModePrototype.uncaughtCrash.call(context, error, origin);
}

function createVmImportError(source: "<anonymous>" | "evalmachine.<anonymous>"): Error {
	const error = Object.assign(new TypeError("A dynamic import callback was not specified."), {
		code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
	});
	error.stack = [
		"TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]: A dynamic import callback was not specified.",
		"    at importModuleDynamicallyCallback (node:internal/modules/esm/utils:279:9)",
		`    at Timeout._onTimeout (${source}:1:16)`,
		"    at listOnTimeout (node:internal/timers:605:17)",
	].join("\n");
	return error;
}

function createCrashContext(): UncaughtCrashThis {
	return {
		isShuttingDown: false,
		showWarning: vi.fn(),
		ui: { stop: vi.fn() },
		unregisterSignalHandlers: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	if (originalRecoveryFlag === undefined) {
		delete process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT;
	} else {
		process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT = originalRecoveryFlag;
	}
});

describe("Inspector VM dynamic import crash handling", () => {
	test("hands the fixed Inspector endpoint from the launcher to cli-main", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-fixed-port.ts", import.meta.url));
		const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath, cliPath, "--help"], {
			encoding: "utf8",
			env: {
				...process.env,
				NODE_OPTIONS: "--inspect=127.0.0.1:0",
				PI_OFFLINE: "1",
			},
			timeout: 30_000,
		});
		const output = `${result.stdout}${result.stderr}`;
		const endpoints = [...output.matchAll(/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//g)].map(
			(match) => match[1],
		);

		expect(result.status).toBe(0);
		expect(output).not.toContain("address already in use");
		expect(endpoints).toHaveLength(2);
		expect(new Set(endpoints).size).toBe(1);
	});

	test("keeps the interactive child running for the exact Inspector eval rejection", () => {
		const context = createCrashContext();
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			expect(() =>
				callUncaughtCrash(context, createVmImportError("<anonymous>"), "unhandledRejection"),
			).not.toThrow();
			expect(context.showWarning).toHaveBeenCalledWith(
				"Node Inspector dynamic import is unsupported; use require() or a target-side loader. Senpi kept running.",
			);
			// Recovery must leave the TUI fully alive: no terminal teardown, no signal
			// unregister, and no latch into the shutting-down state.
			expect(context.ui.stop).not.toHaveBeenCalled();
			expect(context.unregisterSignalHandlers).not.toHaveBeenCalled();
			expect(context.isShuttingDown).toBe(false);
		} finally {
			if (openedInspector) closeInspector();
		}
	});

	test("keeps application-owned VM failures on the existing fatal path", () => {
		const context = createCrashContext();
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			expect(() =>
				callUncaughtCrash(context, createVmImportError("evalmachine.<anonymous>"), "unhandledRejection"),
			).toThrow(ProcessExitError);
			expect(exit).toHaveBeenCalledWith(1);
			expect(context.showWarning).not.toHaveBeenCalled();
		} finally {
			if (openedInspector) closeInspector();
		}
	});

	test("does not enable recovery when the environment changes after policy import", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-recovery-env.ts", import.meta.url));
		const env = { ...process.env };
		delete env.SENPI_RECOVER_INSPECTOR_VM_IMPORT;
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath], {
			encoding: "utf8",
			env,
			timeout: 30_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("false");
	});

	test("recovers the exact Inspector rejection during early bootstrap before the TUI exists", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-early-recovery.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath, "recoverable"], {
			encoding: "utf8",
			env: { ...process.env, SENPI_RECOVER_INSPECTOR_VM_IMPORT: "1" },
			timeout: 30_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("recovered:1");
	});

	test("keeps non-matching bootstrap crashes fatal with the early seam installed", () => {
		const fixturePath = fileURLToPath(new URL("../../fixtures/inspector-early-recovery.ts", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath, "fatal"], {
			encoding: "utf8",
			env: { ...process.env, SENPI_RECOVER_INSPECTOR_VM_IMPORT: "1" },
			timeout: 30_000,
		});

		expect(result.status).toBe(1);
		expect(result.stdout).not.toContain("recovered:");
		expect(result.stderr).toContain("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
	});

	test("classifies hostile rejection values without throwing", () => {
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			const hostileHasTrap = new Proxy(
				{},
				{
					has() {
						throw new Error("hostile has trap");
					},
				},
			);
			const hostileGetter = {
				get code(): never {
					throw new Error("hostile code getter");
				},
				stack: "irrelevant",
			};

			expect(isRecoverableInspectorVmImportError(hostileHasTrap, "unhandledRejection")).toBe(false);
			expect(isRecoverableInspectorVmImportError(hostileGetter, "unhandledRejection")).toBe(false);
		} finally {
			if (openedInspector) closeInspector();
		}
	});

	test("keeps direct uncaught exceptions fatal with recovery enabled", () => {
		const context = createCrashContext();
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new ProcessExitError(code);
		});
		const openedInspector = inspectorUrl() === undefined;
		if (openedInspector) openInspector(0, "127.0.0.1", false);

		try {
			expect(() => callUncaughtCrash(context, createVmImportError("<anonymous>"), "uncaughtException")).toThrow(
				ProcessExitError,
			);
			expect(exit).toHaveBeenCalledWith(1);
			expect(context.showWarning).not.toHaveBeenCalled();
		} finally {
			if (openedInspector) closeInspector();
		}
	});
});
