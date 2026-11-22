import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { loadPermissionSettings } from "../../src/core/extensions/builtin/permission-system/settings.ts";
import type { Ruleset } from "../../src/core/extensions/builtin/permission-system/types.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

function withTempDir<T>(run: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "senpi-permission-settings-"));
	try {
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
	writeFileSync(path, JSON.stringify(settings));
}

describe("permission settings", () => {
	it("uses full-access as the default preset", () => {
		return withTempDir((projectDir) => {
			// given
			const settingsManager = SettingsManager.inMemory();

			// when
			const result = loadPermissionSettings(settingsManager, [], projectDir);

			// then
			expect(evaluate("bash", "rm -rf node_modules", result.staticRuleset).action).toBe("allow");
			expect(result.approved).toEqual([]);
		});
	});

	it("lets an explicit ask preset restore prompt-on-unknown behavior", () => {
		return withTempDir((projectDir) => {
			// given
			const agentDir = join(projectDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeSettings(join(agentDir, "settings.json"), { permissionPreset: "ask" });
			const settingsManager = SettingsManager.create(projectDir, agentDir);

			// when
			const result = loadPermissionSettings(settingsManager, [], projectDir);

			// then
			expect(evaluate("bash", "ls", result.staticRuleset).action).toBe("ask");
		});
	});

	it("lets CLI preset and rules override configured presets", () => {
		return withTempDir((projectDir) => {
			// given
			const agentDir = join(projectDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeSettings(join(agentDir, "settings.json"), { permissionPreset: "read-only" });
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			const cliRuleset: Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }];

			// when
			const result = loadPermissionSettings(settingsManager, cliRuleset, projectDir, "workspace");

			// then
			expect(evaluate("edit", "src/index.ts", result.staticRuleset).action).toBe("allow");
			expect(evaluate("bash", "rm -rf node_modules", result.staticRuleset).action).toBe("deny");
		});
	});

	it("applies source precedence from global settings through CLI rules", () => {
		return withTempDir((projectDir) => {
			// given
			const agentDir = join(projectDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeSettings(join(agentDir, "settings.json"), {
				permissionPreset: "workspace",
				permission: {
					bash: "deny",
					edit: "deny",
				},
			});
			mkdirSync(join(projectDir, ".senpi"), { recursive: true });
			writeSettings(join(projectDir, ".senpi", "settings.json"), {
				permissionPreset: "read-only",
				permission: {
					edit: "allow",
				},
			});
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			const cliRuleset: Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }];

			// when
			const result = loadPermissionSettings(settingsManager, cliRuleset, projectDir, "workspace");

			// then
			expect(evaluate("read", "README.md", result.staticRuleset).action).toBe("allow");
			expect(evaluate("edit", "src/index.ts", result.staticRuleset).action).toBe("allow");
			expect(evaluate("bash", "git status", result.staticRuleset).action).toBe("allow");
			expect(evaluate("bash", "rm -rf node_modules", result.staticRuleset).action).toBe("deny");
			expect(evaluate("external_directory", "../outside", result.staticRuleset).action).toBe("ask");
		});
	});

	it("loads accept-edits from settings without granting bash", () => {
		return withTempDir((projectDir) => {
			// given
			const agentDir = join(projectDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeSettings(join(agentDir, "settings.json"), { permissionPreset: "accept-edits" });
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			// when
			const result = loadPermissionSettings(settingsManager, [], projectDir);
			// then
			expect(evaluate("edit", "src/index.ts", result.staticRuleset).action).toBe("allow");
			expect(evaluate("bash", "git status", result.staticRuleset).action).toBe("ask");
		});
	});

	it("rejects invalid permission presets from settings", () => {
		return withTempDir((projectDir) => {
			// given
			const agentDir = join(projectDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeSettings(join(agentDir, "settings.json"), { permissionPreset: "dangerous" });
			const settingsManager = SettingsManager.create(projectDir, agentDir);

			// when/then
			expect(() => loadPermissionSettings(settingsManager, [], projectDir)).toThrow(Error);
		});
	});

	it("rejects invalid project permission presets", () => {
		return withTempDir((projectDir) => {
			// given
			const agentDir = join(projectDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(projectDir, ".senpi"), { recursive: true });
			writeSettings(join(projectDir, ".senpi", "settings.json"), { permissionPreset: "dangerous" });
			const settingsManager = SettingsManager.create(projectDir, agentDir);

			// when/then
			expect(() => loadPermissionSettings(settingsManager, [], projectDir)).toThrow(Error);
		});
	});
});
