import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	currentJsIsolationHost,
	defaultJsIsolation,
	resolveAdvertiseHelpers,
	resolveEnvironments,
	resolveJsIsolation,
	resolveKernelToolsEnabled,
	resolveSandbox,
} from "../src/config/feature-settings.ts";
import { defaultCodemodeSettings, loadCodemodeSettings, resolveEnabledLanguages } from "../src/config/settings.ts";

async function loadFile(contents: unknown): Promise<Awaited<ReturnType<typeof loadCodemodeSettings>>> {
	const root = await mkdtemp(join(tmpdir(), "senpi-codemode-features-"));
	try {
		await mkdir(join(root, ".senpi"), { recursive: true });
		await writeFile(join(root, ".senpi", "codemode.json"), JSON.stringify(contents));
		return await loadCodemodeSettings({ cwd: root, homeDir: root });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("codemode feature settings", () => {
	it("Given no settings file when the new keys resolve then each equals today's behaviour", () => {
		const settings = defaultCodemodeSettings;

		expect(resolveJsIsolation(settings, {}, { executable: "node", platform: "linux" })).toBe("worker");
		expect(resolveSandbox(settings, {})).toEqual({ enabled: false, memoryMb: 64, timeoutSeconds: 300 });
		expect(resolveEnvironments(settings)).toEqual({ autoProvision: true, jsInstaller: "auto", pyInstaller: "pip" });
		expect(resolveAdvertiseHelpers(settings)).toBe(false);
		expect(resolveKernelToolsEnabled(settings)).toBe(true);
		expect(settings.languages.pyInterpreter).toBeUndefined();
	});

	it("Given a file without the new keys when settings load then the resolved settings equal the previous defaults object exactly", async () => {
		const loaded = await loadFile({ runBudgetSeconds: 300 });
		// The defaults as they were before these keys existed, written out so a change to both the defaults and
		// the merge cannot pass unnoticed.
		const previousDefaults = {
			languages: { py: true, js: true, rb: false, jl: false },
			cellTimeoutSeconds: 30,
			foregroundWindowSeconds: 60,
			runBudgetSeconds: 300,
			hardLimitSeconds: 1800,
			maxDetachedCells: 15,
			parallelPoolWidth: 4,
			taskTools: { task: "task", output: "task_output" },
			outputSink: { headBytes: 20_480, maxColumns: 768 },
			statusEvents: true,
			memory: defaultCodemodeSettings.memory,
		};

		expect(loaded.warnings).toEqual([]);
		expect(loaded.settings).toEqual(previousDefaults);
		expect(Object.keys(loaded.settings).sort()).toEqual(Object.keys(previousDefaults).sort());
	});

	it.each([
		["environments", { environments: { futureNested: true } }],
		["isolation", { isolation: { futureNested: true } }],
		["sandbox", { sandbox: { futureNested: true } }],
		["prompt", { prompt: { futureNested: true } }],
		["kernelTools", { kernelTools: { futureNested: true } }],
		["environments.js", { environments: { js: { installer: "bun", futureNested: true } } }],
	])(
		"Given an unknown key inside %s when settings load then that object stays strict and the file falls back to defaults with a warning",
		async (_name, contents) => {
			const loaded = await loadFile({ ...contents, runBudgetSeconds: 120 });

			expect(loaded.settings.runBudgetSeconds).toBe(defaultCodemodeSettings.runBudgetSeconds);
			expect(loaded.warnings.some((warning) => warning.includes("Falling back to codemode defaults"))).toBe(true);
		},
	);

	it("Given every new key set in the file when settings load then each value is kept and resolves", async () => {
		const loaded = await loadFile({
			environments: {
				managedRoot: "/opt/envs",
				autoProvision: false,
				js: { installer: "bun" },
				py: { installer: "pip" },
			},
			isolation: { js: "process" },
			sandbox: { enabled: true, memoryMb: 128, timeoutSeconds: 60 },
			prompt: { advertiseHelpers: true },
			kernelTools: { enabled: false },
			languages: { pyInterpreter: "/usr/bin/python3" },
		});

		expect(loaded.warnings).toEqual([]);
		expect(resolveJsIsolation(loaded.settings, {})).toBe("process");
		expect(resolveSandbox(loaded.settings, {})).toEqual({ enabled: true, memoryMb: 128, timeoutSeconds: 60 });
		expect(resolveEnvironments(loaded.settings)).toEqual({
			managedRoot: "/opt/envs",
			autoProvision: false,
			jsInstaller: "bun",
			pyInstaller: "pip",
		});
		expect(resolveAdvertiseHelpers(loaded.settings)).toBe(true);
		expect(resolveKernelToolsEnabled(loaded.settings)).toBe(false);
		expect(loaded.settings.languages.pyInterpreter).toBe("/usr/bin/python3");
		// The env overrides apply to the four enable flags only; languages.pyInterpreter survives them (#2763).
		expect(resolveEnabledLanguages(loaded.settings, {})).toEqual({
			py: true,
			js: true,
			rb: false,
			jl: false,
			pyInterpreter: "/usr/bin/python3",
		});
	});

	it("Given an isolation value this version does not know when settings load then the file falls back to defaults with a warning and isolation stays worker", async () => {
		const loaded = await loadFile({ isolation: { js: "thread" }, runBudgetSeconds: 120 });

		expect(loaded.warnings.some((warning) => warning.includes("Falling back to codemode defaults"))).toBe(true);
		expect(resolveJsIsolation(loaded.settings, {}, { executable: "node", platform: "linux" })).toBe("worker");
	});

	it.each([
		["a bun executable on macOS", { executable: "bun", platform: "darwin" } as const, "process"],
		["a bun executable on Linux", { executable: "bun", platform: "linux" } as const, "process"],
		["a bun executable on Windows", { executable: "bun", platform: "win32" } as const, "worker"],
		["a node executable", { executable: "node", platform: "darwin" } as const, "worker"],
		["a compiled binary", { executable: undefined, platform: "darwin" } as const, "worker"],
	])(
		"Given no isolation setting when the host runs on %s then the default isolation is %s",
		(_label, host, expected) => {
			expect(defaultJsIsolation(host)).toBe(expected);
			expect(resolveJsIsolation(defaultCodemodeSettings, {}, host)).toBe(expected);
		},
	);

	it("Given an explicit isolation setting when the host default differs then the setting wins on every host", async () => {
		const worker = await loadFile({ isolation: { js: "worker" } });
		const process = await loadFile({ isolation: { js: "process" } });

		const macBun = { executable: "bun", platform: "darwin" } as const;
		const winBun = { executable: "bun", platform: "win32" } as const;
		const node = { executable: "node", platform: "linux" } as const;
		const compiled = { executable: undefined, platform: "darwin" } as const;
		expect(resolveJsIsolation(worker.settings, {}, macBun)).toBe("worker");
		expect(resolveJsIsolation(process.settings, {}, node)).toBe("process");
		expect(resolveJsIsolation(process.settings, {}, compiled)).toBe("process");
		expect(resolveJsIsolation(process.settings, {}, winBun)).toBe("process");
	});

	it.each([
		["/home/tester/.bun/bin/bun", "linux", "bun"],
		["/c/Users/tester/.bun/bin/bun.exe", "win32", "bun"],
		["/usr/local/bin/node", "darwin", "node"],
		["/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo", "darwin", undefined],
	] as const)(
		"Given the host executable %s on %s when the isolation host is read then its executable is %s",
		(execPath, platform, executable) => {
			expect(currentJsIsolationHost(execPath, platform)).toEqual({ executable, platform });
		},
	);

	it("Given the running test host when the isolation host is read then it names this process's own runtime and platform", () => {
		expect(currentJsIsolationHost()).toEqual({
			executable: process.versions.bun === undefined ? "node" : "bun",
			platform: process.platform,
		});
	});

	it("Given environment overrides when isolation and the sandbox memory resolve then valid values win and invalid ones are ignored", () => {
		const settings = defaultCodemodeSettings;
		const node = { executable: "node", platform: "linux" } as const;
		const bun = { executable: "bun", platform: "darwin" } as const;

		expect(resolveJsIsolation(settings, { SENPI_CODEMODE_JS_ISOLATION: "process" }, node)).toBe("process");
		expect(resolveJsIsolation(settings, { SENPI_CODEMODE_JS_ISOLATION: "worker" }, bun)).toBe("worker");
		expect(resolveJsIsolation(settings, { SENPI_CODEMODE_JS_ISOLATION: "thread" }, node)).toBe("worker");
		expect(resolveJsIsolation(settings, { SENPI_CODEMODE_JS_ISOLATION: "thread" }, bun)).toBe("process");
		expect(resolveSandbox(settings, { SENPI_CODEMODE_SANDBOX_MEMORY_MB: "256" }).memoryMb).toBe(256);
		expect(resolveSandbox(settings, { SENPI_CODEMODE_SANDBOX_MEMORY_MB: "-1" }).memoryMb).toBe(64);
	});
});
