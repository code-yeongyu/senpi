import { afterEach, describe, expect, test, vi } from "vitest";

const stderrGuard = vi.hoisted(() => ({ installed: false }));

vi.mock("../../../src/modes/interactive/interactive-stderr-guard.ts", () => ({
	takeOverInteractiveStderr: vi.fn(() => {
		stderrGuard.installed = true;
	}),
	restoreInteractiveStderr: vi.fn(() => {
		stderrGuard.installed = false;
	}),
}));

const { InteractiveMode } = await import("../../../src/modes/interactive/interactive-mode.ts");

class ProcessExitError extends Error {}

type ShutdownContext = {
	isShuttingDown: boolean;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: (options?: { restoreStderr?: boolean }) => void;
	sessionManager: { isPersisted: () => boolean };
};

type InteractiveModePrototype = {
	shutdown(this: ShutdownContext, options?: { fromSignal?: boolean }): Promise<void>;
};

const shutdown = (InteractiveMode.prototype as unknown as InteractiveModePrototype).shutdown;

function createContext(dispose: () => Promise<void>): ShutdownContext {
	return {
		isShuttingDown: false,
		runtimeHost: { dispose },
		ui: { terminal: { drainInput: vi.fn(async () => {}) } },
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn((options) => {
			if (options?.restoreStderr !== false) stderrGuard.installed = false;
		}),
		sessionManager: { isPersisted: () => false },
	};
}

async function callShutdown(context: ShutdownContext): Promise<void> {
	try {
		await shutdown.call(context);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("interactive quit stderr guard", () => {
	afterEach(() => {
		stderrGuard.installed = false;
		vi.restoreAllMocks();
	});

	test("keeps stderr captured while session shutdown drains and restores it afterward", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		stderrGuard.installed = true;
		let capturedDuringDispose = false;
		const context = createContext(async () => {
			capturedDuringDispose = stderrGuard.installed;
		});

		await callShutdown(context);

		expect(capturedDuringDispose).toBe(true);
		expect(stderrGuard.installed).toBe(false);
	});

	test("restores stderr if session shutdown fails", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		stderrGuard.installed = true;
		const context = createContext(async () => {
			throw new Error("dispose failed");
		});

		await expect(callShutdown(context)).rejects.toThrow("dispose failed");
		expect(stderrGuard.installed).toBe(false);
	});
});
