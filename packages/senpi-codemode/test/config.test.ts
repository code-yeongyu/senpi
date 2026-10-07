import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveRetainedImagesBytes, resolveRetainedResultsBytes } from "../src/config/memory-settings.ts";
import {
	defaultCodemodeSettings,
	loadCodemodeSettings,
	resolveEnabledLanguages,
	resolveForegroundWindowSeconds,
	resolveHardLimitSeconds,
	resolveRunBudgetSeconds,
} from "../src/config/settings.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";
import { QueuedFakeKernel } from "./eval/queued-fake.ts";

describe("codemode settings", () => {
	it.each([
		{ name: "default cap", file: {}, env: undefined, capacity: 15 },
		{ name: "file cap", file: { maxDetachedCells: 4 }, env: undefined, capacity: 4 },
		{ name: "environment cap", file: { maxDetachedCells: 4 }, env: "2", capacity: 2 },
		{ name: "invalid environment cap", file: { maxDetachedCells: 4 }, env: "0", capacity: 4 },
		{ name: "malformed environment cap", file: { maxDetachedCells: 4 }, env: "bad", capacity: 4 },
	])("enforces the $name through the tool's detached manager", async ({ file, env, capacity }) => {
		// Given resolved file settings and the real tool/manager with an event-gated kernel.
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-cap-"));
		const kernel = new QueuedFakeKernel();
		const pending: Promise<unknown>[] = [];
		vi.stubEnv("SENPI_CODEMODE_MAX_DETACHED_CELLS", env);
		try {
			await mkdir(join(root, ".senpi"));
			await writeFile(join(root, ".senpi", "codemode.json"), JSON.stringify(file));
			const loaded = await loadCodemodeSettings({ cwd: root, homeDir: root });
			expect(loaded.warnings).toEqual([]);
			vi.useFakeTimers();
			const detach = vi.spyOn(EvalDetachedCellManager.prototype, "detach");
			const tool = createEvalTool({
				enabledLanguages: loaded.settings.languages,
				settings: loaded.settings,
				kernelManager: new FakeManager([["js", kernel]]),
				cellTimeoutSeconds: 1,
				executeTool: async () => {
					throw new Error("No host tool is expected");
				},
			});
			// When one more cell than the resolved capacity asks to detach.
			for (let index = 0; index <= capacity; index++) {
				const id = `cap-${index}`;
				const admitted = kernel.admitted(id);
				pending.push(
					tool.execute(id, { language: "js", code: id, summary: id }, undefined, undefined, {
						...fakeExtensionContext(),
						mode: "tui",
					}),
				);
				await admitted;
				await vi.advanceTimersByTimeAsync(1000);
			}
			// Then the manager admits exactly the cap and refuses the next detach.
			expect(detach.mock.results.map((entry) => entry.value)).toEqual([
				...Array.from({ length: capacity }, () => true),
				false,
			]);
		} finally {
			while (kernel.queueSnapshot().activeCellId !== null) {
				const active = kernel.queueSnapshot().activeCellId;
				if (active !== null) kernel.completeDeferredRun(result(active, "finished"));
			}
			await Promise.all(pending);
			await vi.runOnlyPendingTimersAsync();
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			vi.useRealTimers();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([0, -1])("rejects maxDetachedCells %s with a settings warning", async (maxDetachedCells) => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-cap-"));
		try {
			await mkdir(join(root, ".senpi"));
			await writeFile(join(root, ".senpi", "codemode.json"), JSON.stringify({ maxDetachedCells }));
			const loaded = await loadCodemodeSettings({ cwd: root, homeDir: root });
			expect(loaded.warnings).toHaveLength(1);
			expect(loaded.settings.maxDetachedCells).toBe(15);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("Given a settings file with a key from a newer version when settings load then the other settings still apply and the unknown key gets one warning", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-future-key-"));
		try {
			await mkdir(join(root, ".senpi"), { recursive: true });
			await writeFile(
				join(root, ".senpi", "codemode.json"),
				JSON.stringify({ futureKey: 1, runBudgetSeconds: 120 }),
			);

			const loaded = await loadCodemodeSettings({ cwd: root, homeDir: root });

			expect(loaded.settings.runBudgetSeconds).toBe(120);
			expect(loaded.warnings).toHaveLength(1);
			expect(loaded.warnings[0]).toContain("futureKey");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("Given an unknown key inside a known setting when settings load then the file still falls back to defaults with a warning", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-nested-unknown-"));
		try {
			await mkdir(join(root, ".senpi"), { recursive: true });
			await writeFile(
				join(root, ".senpi", "codemode.json"),
				JSON.stringify({ runBudgetSeconds: 120, taskTools: { task: "task", futureNested: true } }),
			);

			const loaded = await loadCodemodeSettings({ cwd: root, homeDir: root });

			expect(loaded.settings.runBudgetSeconds).toBe(defaultCodemodeSettings.runBudgetSeconds);
			expect(loaded.warnings.some((warning) => warning.includes("Falling back to codemode defaults"))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("accepts a positive numeric maxDetachedCells setting", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-cap-"));
		try {
			await mkdir(join(root, ".senpi"));
			await writeFile(join(root, ".senpi", "codemode.json"), JSON.stringify({ maxDetachedCells: 2.5 }));
			const loaded = await loadCodemodeSettings({ cwd: root, homeDir: root });
			expect(loaded.warnings).toEqual([]);
			expect(loaded.settings.maxDetachedCells).toBe(2.5);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses project config before global config before defaults", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await mkdir(join(homeDir, ".senpi", "agent"), { recursive: true });
			await writeFile(
				join(projectDir, ".senpi", "codemode.json"),
				JSON.stringify({ languages: { py: false, rb: true }, parallelPoolWidth: 9, maxDetachedCells: 2 }),
			);
			await writeFile(
				join(homeDir, ".senpi", "agent", "codemode.json"),
				JSON.stringify({ languages: { js: false, jl: true }, cellTimeoutSeconds: 12 }),
				{},
			);

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir });

			expect(loaded.source).toBe(join(projectDir, ".senpi", "codemode.json"));
			expect(loaded.warnings).toEqual([]);
			expect(loaded.settings).toEqual({
				languages: { py: false, js: true, rb: true, jl: false },
				cellTimeoutSeconds: 30,
				foregroundWindowSeconds: 60,
				runBudgetSeconds: 300,
				hardLimitSeconds: 1800,
				parallelPoolWidth: 9,
				maxDetachedCells: 2,
				taskTools: { task: "task", output: "task_output" },
				outputSink: { headBytes: 20480, maxColumns: 768 },
				statusEvents: true,
				memory: defaultCodemodeSettings.memory,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to global config when project config is missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(homeDir, ".senpi", "agent"), { recursive: true });
			await writeFile(
				join(homeDir, ".senpi", "agent", "codemode.json"),
				JSON.stringify({ languages: { js: false, jl: true }, cellTimeoutSeconds: 12 }),
				{},
			);

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir });

			expect(loaded.source).toBe(join(homeDir, ".senpi", "agent", "codemode.json"));
			expect(loaded.settings).toEqual({
				languages: { py: true, js: false, rb: false, jl: true },
				cellTimeoutSeconds: 12,
				foregroundWindowSeconds: 60,
				runBudgetSeconds: 300,
				hardLimitSeconds: 1800,
				parallelPoolWidth: 4,
				maxDetachedCells: 15,
				taskTools: { task: "task", output: "task_output" },
				outputSink: { headBytes: 20480, maxColumns: 768 },
				statusEvents: true,
				memory: defaultCodemodeSettings.memory,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses taskTools defaults", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const loaded = await loadCodemodeSettings({ cwd: join(root, "project"), homeDir: join(root, "home") });

			expect(loaded.settings.taskTools).toEqual({ task: "task", output: "task_output" });
			expect(loaded.settings.outputSink).toEqual({ headBytes: 20480, maxColumns: 768 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses statusEvents default true", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const loaded = await loadCodemodeSettings({ cwd: join(root, "project"), homeDir: join(root, "home") });

			expect(loaded.settings.statusEvents).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("env override beats file settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(
				join(projectDir, ".senpi", "codemode.json"),
				JSON.stringify({ languages: { py: false, js: true, rb: true, jl: false } }),
			);

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir });
			const languages = resolveEnabledLanguages(loaded.settings, {
				SENPI_CODEMODE_PY: "1",
				SENPI_CODEMODE_JS: "0",
				SENPI_CODEMODE_RB: "false",
				SENPI_CODEMODE_JL: "true",
			});

			expect(languages).toEqual({ py: true, js: false, rb: false, jl: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores an unknown top-level key with a warning and keeps today's defaults", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(join(projectDir, ".senpi", "codemode.json"), JSON.stringify({ unknown: true }));

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir });

			expect(loaded.settings).toEqual(defaultCodemodeSettings);
			expect(loaded.warnings).toHaveLength(1);
			expect(loaded.warnings[0]).toContain('Unknown codemode setting "unknown"');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("warns for malformed new settings values", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(
				join(projectDir, ".senpi", "codemode.json"),
				JSON.stringify({ outputSink: { headBytes: -1 }, statusEvents: "yes" }),
			);

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir });

			expect(loaded.settings).toEqual(defaultCodemodeSettings);
			expect(loaded.warnings).toHaveLength(1);
			expect(loaded.warnings[0]).toContain("Invalid codemode settings");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns defaults with warnings for invalid json and invalid values", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(join(projectDir, ".senpi", "codemode.json"), "{not-json");

			const malformed = await loadCodemodeSettings({ cwd: projectDir, homeDir });

			expect(malformed.settings).toEqual(defaultCodemodeSettings);
			expect(malformed.warnings).toHaveLength(1);
			expect(malformed.warnings[0]).toContain("Invalid JSON");

			await writeFile(
				join(projectDir, ".senpi", "codemode.json"),
				JSON.stringify({ languages: { py: "yes" }, cellTimeoutSeconds: 0 }),
			);

			const invalid = await loadCodemodeSettings({ cwd: projectDir, homeDir });

			expect(invalid.settings).toEqual(defaultCodemodeSettings);
			expect(invalid.warnings).toHaveLength(1);
			expect(invalid.warnings[0]).toContain("Invalid codemode settings");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("defaults hardLimitSeconds to the bash-parity kill deadline", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const loaded = await loadCodemodeSettings({ cwd: join(root, "project"), homeDir: join(root, "home") });

			expect(loaded.settings.hardLimitSeconds).toBe(1800);
			expect(defaultCodemodeSettings.hardLimitSeconds).toBe(1800);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads hardLimitSeconds from the settings file", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(join(projectDir, ".senpi", "codemode.json"), JSON.stringify({ hardLimitSeconds: 90 }));

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir: join(root, "home") });

			expect(loaded.warnings).toEqual([]);
			expect(loaded.settings.hardLimitSeconds).toBe(90);
			expect(resolveHardLimitSeconds(loaded.settings, {})).toBe(90);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lets the environment override beat the settings file hard limit", () => {
		const settings = { ...defaultCodemodeSettings, hardLimitSeconds: 90 };

		expect(resolveHardLimitSeconds(settings, { SENPI_CODEMODE_HARD_LIMIT_SECONDS: "45" })).toBe(45);
	});

	it("ignores a non-positive or malformed hard limit environment value", () => {
		const settings = { ...defaultCodemodeSettings, hardLimitSeconds: 90 };

		for (const value of ["0", "-5", "abc", ""]) {
			expect(resolveHardLimitSeconds(settings, { SENPI_CODEMODE_HARD_LIMIT_SECONDS: value })).toBe(90);
		}
	});

	it("defaults runBudgetSeconds to five minutes of own execution time", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const loaded = await loadCodemodeSettings({ cwd: join(root, "project"), homeDir: join(root, "home") });

			expect(loaded.settings.runBudgetSeconds).toBe(300);
			expect(defaultCodemodeSettings.runBudgetSeconds).toBe(300);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads runBudgetSeconds from the settings file and lets the environment override it", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(join(projectDir, ".senpi", "codemode.json"), JSON.stringify({ runBudgetSeconds: 45 }));

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir: join(root, "home") });

			expect(loaded.warnings).toEqual([]);
			expect(loaded.settings.runBudgetSeconds).toBe(45);
			expect(resolveRunBudgetSeconds(loaded.settings, {})).toBe(45);
			expect(resolveRunBudgetSeconds(loaded.settings, { SENPI_CODEMODE_RUN_BUDGET_SECONDS: "20" })).toBe(20);
			for (const value of ["0", "-5", "abc", ""]) {
				expect(resolveRunBudgetSeconds(loaded.settings, { SENPI_CODEMODE_RUN_BUDGET_SECONDS: value })).toBe(45);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("defaults foregroundWindowSeconds to the bash-parity 60s window", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const loaded = await loadCodemodeSettings({ cwd: join(root, "project"), homeDir: join(root, "home") });

			expect(loaded.settings.foregroundWindowSeconds).toBe(60);
			expect(defaultCodemodeSettings.foregroundWindowSeconds).toBe(60);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads foregroundWindowSeconds from the settings file", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(join(projectDir, ".senpi", "codemode.json"), JSON.stringify({ foregroundWindowSeconds: 15 }));

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir: join(root, "home") });

			expect(loaded.warnings).toEqual([]);
			expect(loaded.settings.foregroundWindowSeconds).toBe(15);
			expect(resolveForegroundWindowSeconds(loaded.settings, {})).toBe(15);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lets the environment override beat the settings file foreground window", () => {
		const settings = { ...defaultCodemodeSettings, foregroundWindowSeconds: 15 };

		expect(resolveForegroundWindowSeconds(settings, { SENPI_CODEMODE_FOREGROUND_SECONDS: "7" })).toBe(7);
	});

	it("ignores a non-positive or malformed foreground window environment value", () => {
		const settings = { ...defaultCodemodeSettings, foregroundWindowSeconds: 15 };

		for (const value of ["0", "-5", "abc", ""]) {
			expect(resolveForegroundWindowSeconds(settings, { SENPI_CODEMODE_FOREGROUND_SECONDS: value })).toBe(15);
		}
	});

	it("resolves the settled-result memory and image-spill budgets from defaults, the file, and the environment", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(
				join(projectDir, ".senpi", "codemode.json"),
				JSON.stringify({ memory: { retainedResultsMb: 8, retainedImagesMb: 64 } }),
			);
			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir: join(root, "home") });

			expect(loaded.warnings).toEqual([]);
			for (const [resolve, flag, fallback, fromFile] of [
				[resolveRetainedResultsBytes, "SENPI_CODEMODE_RETAINED_RESULTS_MB", 32, 8],
				[resolveRetainedImagesBytes, "SENPI_CODEMODE_RETAINED_IMAGES_MB", 256, 64],
			] as const) {
				expect(resolve(defaultCodemodeSettings, {})).toBe(fallback * 1024 * 1024);
				expect(resolve(loaded.settings, {})).toBe(fromFile * 1024 * 1024);
				expect(resolve(loaded.settings, { [flag]: "4" })).toBe(4 * 1024 * 1024);
				expect(resolve(loaded.settings, { [flag]: "0" })).toBe(0);
				for (const value of ["-1", "abc", "", "1.5"]) {
					expect(resolve(loaded.settings, { [flag]: value })).toBe(fromFile * 1024 * 1024);
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
