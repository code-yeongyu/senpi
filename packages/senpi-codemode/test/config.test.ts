import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCodemodeSettings, loadCodemodeSettings } from "../src/config/settings.ts";

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
			});
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
