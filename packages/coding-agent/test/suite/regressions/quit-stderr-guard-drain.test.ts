import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "../../../src/core/lockfile-policy.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

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
	settingsManager: SettingsManager;
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

function createContext(dispose: () => Promise<void>, settingsManager = SettingsManager.inMemory()): ShutdownContext {
	return {
		isShuttingDown: false,
		settingsManager,
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

describe("interactive quit", () => {
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

	// oh-my-openagent#9630
	test("publishes pending per-model thinking levels before process exit", async () => {
		const agentDir = makeTempDir(join(tmpdir(), "senpi-quit-thinking-"));
		const statePath = join(agentDir, "state.json");
		const modelKey = "faux/think";
		writeFileSync(
			statePath,
			JSON.stringify({
				modelThinkingLevels: { [modelKey]: "low" },
				modelLastOnThinkingLevels: { [modelKey]: "low" },
			}),
		);
		const settings = SettingsManager.create(agentDir, agentDir);
		const release = await lockfile.lock(statePath, FILE_STORAGE_LOCK_OPTIONS);
		const mayUnlock = Promise.withResolvers<void>();
		const unlocked = mayUnlock.promise.then(() => release());
		let stateAtExit: string | undefined;
		vi.spyOn(process, "exit").mockImplementation(() => {
			stateAtExit = readFileSync(statePath, "utf-8");
			throw new ProcessExitError();
		});
		const context = createContext(async () => {
			// A contending writer releases on the next event-loop turn, after disposal has returned.
			setImmediate(mayUnlock.resolve);
		}, settings);

		try {
			settings.setModelThinkingLevel("faux", "think", "medium");
			await callShutdown(context);
			expect(JSON.parse(stateAtExit ?? "{}")).toMatchObject({
				modelThinkingLevels: { [modelKey]: "medium" },
				modelLastOnThinkingLevels: { [modelKey]: "medium" },
			});
		} finally {
			mayUnlock.resolve();
			await unlocked;
			await settings.flush();
		}
	});
});
