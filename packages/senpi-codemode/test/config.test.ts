import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCodemodeSettings, loadCodemodeSettings, resolveEnabledLanguages } from "../src/config/settings.ts";

describe("codemode settings", () => {
	it("uses project config before global config before defaults", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await mkdir(join(homeDir, ".senpi", "agent"), { recursive: true });
			await writeFile(
				join(projectDir, ".senpi", "codemode.json"),
				JSON.stringify({ languages: { py: false, rb: true }, parallelPoolWidth: 9 }),
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
				parallelPoolWidth: 9,
				taskTools: { task: "task", output: "task_output" },
				outputSink: { headBytes: 20480, maxColumns: 768 },
				statusEvents: true,
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
				parallelPoolWidth: 4,
				taskTools: { task: "task", output: "task_output" },
				outputSink: { headBytes: 20480, maxColumns: 768 },
				statusEvents: true,
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

	it("rejects unknown settings keys with a warning", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-config-"));
		try {
			const projectDir = join(root, "project");
			const homeDir = join(root, "home");
			await mkdir(join(projectDir, ".senpi"), { recursive: true });
			await writeFile(join(projectDir, ".senpi", "codemode.json"), JSON.stringify({ unknown: true }));

			const loaded = await loadCodemodeSettings({ cwd: projectDir, homeDir });

			expect(loaded.settings).toEqual(defaultCodemodeSettings);
			expect(loaded.warnings).toHaveLength(1);
			expect(loaded.warnings[0]).toContain("Invalid codemode settings");
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
});
