import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	excludeRoutineOnlySettingsChanges,
	refreshSettingsContentSnapshots,
} from "../src/core/extensions/builtin/config-reload/routine-settings.ts";
import {
	__resetSelfWriteTrackerForTests,
	__setSelfWriteTrackerClockForTests,
	getInMemorySettingsPath,
	getSettingsPath,
	InMemorySettingsStorage,
	SettingsManager,
	wasSelfWrite,
} from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	const testDir = join(tmpdir(), `senpi-settings-${process.pid}`);
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("JSONC settings sources", () => {
		it("loads comments and trailing commas without treating comment markers inside strings as syntax", () => {
			writeFileSync(
				join(agentDir, "settings.jsonc"),
				`{
					// line comment
					"theme": "dark",
					"shellCommandPrefix": "echo // literal /* text */",
					/* block comment */
					"favoriteModels": ["openai/gpt-5.5",],
				}`,
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBe("dark");
			expect(manager.getShellCommandPrefix()).toBe("echo // literal /* text */");
			expect(manager.getFavoriteModels()).toEqual(["openai/gpt-5.5"]);
		});

		it("prefers settings.jsonc when both settings formats exist", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
			writeFileSync(join(agentDir, "settings.jsonc"), '{ "theme": "dark", }');

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBe("dark");
			expect(manager.getSelectedSettingsSources()).toContainEqual({
				path: join(agentDir, "settings.jsonc"),
				format: "jsonc",
				reason: "explicit-jsonc",
				scope: "global",
			});
		});

		it("keeps settings.json as the source when it is the only settings file", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBe("light");
			expect(manager.getSelectedSettingsSources()).toContainEqual({
				path: join(agentDir, "settings.json"),
				format: "json",
				reason: "json-only",
				scope: "global",
			});
		});

		it("writes back to the loaded JSONC path without creating settings.json", async () => {
			const jsoncPath = join(agentDir, "settings.jsonc");
			writeFileSync(jsoncPath, '{ "theme": "dark", }');
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setDefaultModel("gpt-5.5");
			await manager.flush();

			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
			expect(JSON.parse(readFileSync(jsoncPath, "utf-8"))).toMatchObject({
				theme: "dark",
				defaultModel: "gpt-5.5",
			});
		});

		it("reselects JSONC on reload and keeps later writes on that path", async () => {
			const jsonPath = join(agentDir, "settings.json");
			const jsoncPath = join(agentDir, "settings.jsonc");
			writeFileSync(jsonPath, JSON.stringify({ theme: "light" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			writeFileSync(jsoncPath, '{ "theme": "dark", }');

			await manager.reload();
			manager.setDefaultModel("gpt-5.5");
			await manager.flush();

			expect(manager.getTheme()).toBe("dark");
			expect(JSON.parse(readFileSync(jsonPath, "utf-8"))).toEqual({ theme: "light" });
			expect(JSON.parse(readFileSync(jsoncPath, "utf-8"))).toMatchObject({ defaultModel: "gpt-5.5" });
		});
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should default steering mode to all when unset", () => {
			// given
			const manager = SettingsManager.create(projectDir, agentDir);

			// when
			const steeringMode = manager.getSteeringMode();

			// then
			expect(steeringMode).toBe("all");
		});

		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings and report the file path when the file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
			expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: settingsPath }]);
		});
	});

	describe("theme setting", () => {
		it("stores slash-separated automatic theme settings separately from fixed theme names", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "light/dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBeUndefined();
			expect(manager.getThemeSetting()).toBe("light/dark");

			manager.setTheme("solarized-light/tokyo-night");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.theme).toBe("solarized-light/tokyo-night");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, CONFIG_DIR_NAME, "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors).toMatchObject([
				{ scope: "global", path: globalSettingsPath },
				{ scope: "project", path: projectSettingsPath },
			]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("retry", () => {
		it("should leave provider timeout unset by default", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ theme: "dark" }));

			const whenManager = SettingsManager.create(projectDir, agentDir);
			const thenRetrySettings = whenManager.getProviderRetrySettings();

			expect(thenRetrySettings.timeoutMs).toBeUndefined();
		});

		it("should preserve explicit provider timeout", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ retry: { provider: { timeoutMs: 12_345 } } }));

			const whenManager = SettingsManager.create(projectDir, agentDir);
			const thenRetrySettings = whenManager.getProviderRetrySettings();

			expect(thenRetrySettings.timeoutMs).toBe(12_345);
		});

		it("should default the provider stream retry timeout to 30s", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ theme: "dark" }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getProviderStreamRetryTimeoutMs()).toBe(30_000);
		});

		it("should prefer retry.provider.streamRetryTimeoutMs", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ retry: { provider: { streamRetryTimeoutMs: 45_000 } } }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getProviderStreamRetryTimeoutMs()).toBe(45_000);
		});

		it("should disable the provider stream retry cap when streamRetryTimeoutMs is 0", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ retry: { provider: { streamRetryTimeoutMs: 0 } } }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getProviderStreamRetryTimeoutMs()).toBeUndefined();
		});

		it("should default the agent stream idle timeout to httpIdleTimeoutMs", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ theme: "dark" }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamIdleTimeoutMs()).toBe(300_000);
		});

		it("should follow a custom httpIdleTimeoutMs for the agent stream idle timeout", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ httpIdleTimeoutMs: 60_000 }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamIdleTimeoutMs()).toBe(60_000);
		});

		it("should disable the agent stream idle timeout when httpIdleTimeoutMs is 0", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamIdleTimeoutMs()).toBeUndefined();
		});

		it("should prefer retry.provider.timeoutMs for the agent stream idle timeout", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(
				givenSettingsPath,
				JSON.stringify({ httpIdleTimeoutMs: 0, retry: { provider: { timeoutMs: 5_000 } } }),
			);

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamIdleTimeoutMs()).toBe(5_000);
		});

		it("should default retry.maxRetries to the shipped turn budget", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ theme: "dark" }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getRetrySettings().maxRetries).toBe(5);
		});

		it("should prefer an explicit retry.maxRetries over the default", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ retry: { maxRetries: 2 } }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getRetrySettings().maxRetries).toBe(2);
		});

		it("should default the agent stream start timeout to 300s", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ theme: "dark" }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamStartTimeoutMs()).toBe(300_000);
		});

		it("should prefer retry.provider.streamStartTimeoutMs for the agent stream start timeout", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ retry: { provider: { streamStartTimeoutMs: 30_000 } } }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamStartTimeoutMs()).toBe(30_000);
		});

		it("should disable the agent stream start timeout when streamStartTimeoutMs is 0", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ retry: { provider: { streamStartTimeoutMs: 0 } } }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamStartTimeoutMs()).toBeUndefined();
		});

		it("should disable the default agent stream start timeout when the idle guard is disabled", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamStartTimeoutMs()).toBeUndefined();
		});

		it("should clamp the default agent stream start timeout to a shorter idle timeout", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(givenSettingsPath, JSON.stringify({ httpIdleTimeoutMs: 60_000 }));

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamStartTimeoutMs()).toBe(60_000);
		});

		it("should keep an explicit agent stream start timeout even above the idle timeout", () => {
			const givenSettingsPath = join(agentDir, "settings.json");
			writeFileSync(
				givenSettingsPath,
				JSON.stringify({ httpIdleTimeoutMs: 60_000, retry: { provider: { streamStartTimeoutMs: 120_000 } } }),
			);

			const whenManager = SettingsManager.create(projectDir, agentDir);

			expect(whenManager.getAgentStreamStartTimeoutMs()).toBe(120_000);
		});
	});

	describe("project trust", () => {
		it("should skip project settings when project is not trusted", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ theme: "project" }));

			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.isProjectTrusted()).toBe(false);
			expect(manager.getTheme()).toBe("global");
			expect(manager.getProjectSettings()).toEqual({});
		});

		it("should reload project settings after trust changes to true", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ theme: "project" }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			manager.setProjectTrusted(true);

			expect(manager.isProjectTrusted()).toBe(true);
			expect(manager.getTheme()).toBe("project");
		});

		it("should fail project settings writes when project is not trusted", async () => {
			const projectSettingsPath = join(projectDir, CONFIG_DIR_NAME, "settings.json");
			writeFileSync(projectSettingsPath, JSON.stringify({ packages: ["npm:existing"] }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(() => manager.setProjectPackages(["npm:new"])).toThrow(
				"Project is not trusted; refusing to write project settings",
			);
			await manager.flush();

			expect(manager.getProjectSettings()).toEqual({});
			expect(JSON.parse(readFileSync(projectSettingsPath, "utf-8"))).toEqual({ packages: ["npm:existing"] });
		});

		it("should read default project trust from global settings only", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
			writeFileSync(
				join(projectDir, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ defaultProjectTrust: "never" }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("always");
		});

		it("should default invalid project trust settings to ask", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "sometimes" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("ask");
		});

		it("should read a non-negative historical image limit", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ images: { maxHistoricalImages: 2 } }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getMaxHistoricalImages()).toBe(2);
		});

		it("should ignore invalid historical image limits", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ images: { maxHistoricalImages: -1 } }));
			const negative = SettingsManager.create(projectDir, agentDir);
			expect(negative.getMaxHistoricalImages()).toBeUndefined();

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ images: { maxHistoricalImages: 1.5 } }));
			const fractional = SettingsManager.create(projectDir, agentDir);
			expect(fractional.getMaxHistoricalImages()).toBeUndefined();
		});
	});

	describe("project settings directory creation", () => {
		it("should not create project config folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO project config folder
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the project config folder that beforeEach created
			rmSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Project config folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, CONFIG_DIR_NAME))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create project config folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO project config folder
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the project config folder that beforeEach created
			rmSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// Project config folder should NOT exist yet
			expect(existsSync(join(projectDir, CONFIG_DIR_NAME))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now project config folder should exist
			expect(existsSync(join(projectDir, CONFIG_DIR_NAME))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"))).toBe(true);
		});
	});

	describe("externalEditor", () => {
		const originalVisual = process.env.VISUAL;
		const originalEditor = process.env.EDITOR;
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

		function setEditorEnv(visual?: string, editor?: string): void {
			if (visual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = visual;
			if (editor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = editor;
		}

		afterEach(() => {
			setEditorEnv(originalVisual, originalEditor);
			if (originalPlatform) {
				Object.defineProperty(process, "platform", originalPlatform);
			}
		});

		it("should resolve editor commands by precedence", () => {
			setEditorEnv("vim", "nano");
			expect(SettingsManager.inMemory({ externalEditor: "code --wait" }).getExternalEditorCommand()).toBe(
				"code --wait",
			);
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("vim");

			setEditorEnv(undefined, "emacs");
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("emacs");
		});

		it("should fall back to platform defaults", () => {
			setEditorEnv();
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("notepad");

			Object.defineProperty(process, "platform", { value: "darwin" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");

			Object.defineProperty(process, "platform", { value: "linux" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");
		});
	});

	describe("TUI mode", () => {
		it("defaults to regular and persists fullscreen mode", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("regular");

			manager.setTuiMode("fullscreen");
			await manager.flush();

			expect(manager.getTuiMode()).toBe("fullscreen");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.tuiMode).toBe("fullscreen");
		});

		it("falls back to regular for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "other" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("regular");
		});

		it("does not recognize the old uiMode setting", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ uiMode: "fullscreen" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("regular");
		});
	});

	it("validates and persists fullscreen settings", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFullscreenExitOutput()).toBe("transcript");
		expect(manager.getFullscreenScrollbar()).toBe("auto");

		manager.setFullscreenExitOutput("resume-hint");
		manager.setFullscreenScrollbar("hidden");
		await manager.flush();
		const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(savedSettings.fullscreenExitOutput).toBe("resume-hint");
		expect(savedSettings.fullscreenScrollbar).toBe("hidden");

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ fullscreenExitOutput: "nothing", fullscreenScrollbar: "sometimes" }),
		);
		const reloadedManager = SettingsManager.create(projectDir, agentDir);
		expect(reloadedManager.getFullscreenExitOutput()).toBe("transcript");
		expect(reloadedManager.getFullscreenScrollbar()).toBe("auto");
	});

	describe("outputPad", () => {
		it("should default to 1 and persist binary values", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOutputPad()).toBe(1);

			manager.setOutputPad(0);
			await manager.flush();

			expect(manager.getOutputPad()).toBe(0);
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.outputPad).toBe(0);
		});

		it("should treat unsupported outputPad values as default padding", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ outputPad: 2 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOutputPad()).toBe(1);
		});
	});

	describe("smooth streaming", () => {
		it("defaults smooth streaming on at 60 fps", () => {
			// Given
			const manager = SettingsManager.inMemory();

			// When / Then
			expect(manager.getSmoothStreaming()).toBe(true);
			expect(manager.getSmoothStreamingFps()).toBe(60);
		});

		it.each([
			[29, 30],
			[30, 30],
			[90, 90],
			[120, 120],
			[121, 120],
		] as const)("clamps configured streaming fps %s to %s", (configuredFps, expectedFps) => {
			// Given
			const manager = SettingsManager.inMemory({ smoothStreamingFps: configuredFps });

			// When
			const fps = manager.getSmoothStreamingFps();

			// Then
			expect(fps).toBe(expectedFps);
		});

		it("persists smooth streaming settings", async () => {
			// Given
			const manager = SettingsManager.create(projectDir, agentDir);

			// When
			manager.setSmoothStreaming(false);
			manager.setSmoothStreamingFps(90);
			await manager.flush();

			// Then
			expect(manager.getSmoothStreaming()).toBe(false);
			expect(manager.getSmoothStreamingFps()).toBe(90);
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.smoothStreaming).toBe(false);
			expect(savedSettings.smoothStreamingFps).toBe(90);
		});
	});
	describe("markdown.mermaid", () => {
		it("defaults to streaming and persists rendering modes", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getMermaidRenderingMode()).toBe("streaming");

			manager.setMermaidRenderingMode("final");
			await manager.flush();

			expect(manager.getMermaidRenderingMode()).toBe("final");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.markdown.mermaid).toBe("final");
		});

		it("falls back to streaming for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ markdown: { mermaid: "sometimes" } }));

			expect(SettingsManager.create(projectDir, agentDir).getMermaidRenderingMode()).toBe("streaming");
		});
	});
	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("defaultTools", () => {
		it("loads global defaults and lets project settings replace them", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["read", "bash"]);

			writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ defaultTools: ["grep"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["grep"]);
		});

		it("preserves an empty tool list", () => {
			expect(SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools()).toEqual([]);
			expect(SettingsManager.inMemory().getDefaultTools()).toBeUndefined();
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(
				join(projectDir, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ sessionDir: "./sessions" }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("getShellPath", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBeUndefined();
		});

		it("should return an absolute shellPath unchanged", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/bin/zsh" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe("/bin/zsh");
		});

		it("should expand ~ in shellPath", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ shellPath: "~/.local/bin/agent-shell-sandbox" }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(join(homedir(), ".local/bin/agent-shell-sandbox"));
		});

		it("should expand a bare ~ in shellPath", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "~" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(homedir());
		});
	});

	describe("thinking-level and favorites baseline (characterization)", () => {
		it("round-trips defaultThinkingLevel and favoriteModels without touching each other", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "low", favoriteModels: ["a:high"] }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getDefaultThinkingLevel()).toBe("low");
			expect(manager.getFavoriteModels()).toEqual(["a:high"]);

			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			expect(manager.getDefaultThinkingLevel()).toBe("high");
			expect(manager.getFavoriteModels()).toEqual(["a:high"]);
			const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(saved.defaultThinkingLevel).toBe("high");
			expect(saved.favoriteModels).toEqual(["a:high"]);
			expect(saved.modelThinkingLevels).toBeUndefined();
		});
	});

	describe("per-model thinking level memory", () => {
		it("round-trips a level under an opaque provider/id key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getModelThinkingLevel("openai", "gpt-5.5")).toBeUndefined();
			manager.setModelThinkingLevel("openai", "gpt-5.5", "xhigh");
			await manager.flush();

			expect(manager.getModelThinkingLevel("openai", "gpt-5.5")).toBe("xhigh");
			const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(saved.modelThinkingLevels).toEqual({ "openai/gpt-5.5": "xhigh" });
			expect(saved.theme).toBe("dark");
		});

		it("preserves the last non-off level when the effective level becomes off", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setModelThinkingLevel("openai", "gpt-5.5", "high");
			manager.setModelThinkingLevel("openai", "gpt-5.5", "off");
			await manager.flush();

			const restarted = SettingsManager.create(projectDir, agentDir);
			expect(restarted.getModelThinkingLevel("openai", "gpt-5.5")).toBe("off");
			expect(restarted.getModelLastOnThinkingLevel("openai", "gpt-5.5")).toBe("high");
			expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toMatchObject({
				modelThinkingLevels: { "openai/gpt-5.5": "off" },
				modelLastOnThinkingLevels: { "openai/gpt-5.5": "high" },
			});
		});

		it("keeps ids containing slashes and colons opaque", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setModelThinkingLevel("openrouter", "z-ai/glm-5.2:exacto", "high");
			await manager.flush();

			expect(manager.getModelThinkingLevel("openrouter", "z-ai/glm-5.2:exacto")).toBe("high");
			const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(saved.modelThinkingLevels).toEqual({ "openrouter/z-ai/glm-5.2:exacto": "high" });
		});

		it("deletes only the target key when set to undefined", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({ modelThinkingLevels: { "openai/gpt-5.5": "xhigh", "anthropic/opus": "medium" } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setModelThinkingLevel("openai", "gpt-5.5", undefined);
			await manager.flush();

			expect(manager.getModelThinkingLevel("openai", "gpt-5.5")).toBeUndefined();
			expect(manager.getModelThinkingLevel("anthropic", "opus")).toBe("medium");
			const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(saved.modelThinkingLevels).toEqual({ "anthropic/opus": "medium" });
		});

		it("tolerates malformed persisted values", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					modelThinkingLevels: {
						"openai/number": 3,
						"openai/null": null,
						"openai/object": { level: "high" },
						"openai/unknown": "ultra",
						"openai/good": "high",
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getModelThinkingLevel("openai", "number")).toBeUndefined();
			expect(manager.getModelThinkingLevel("openai", "null")).toBeUndefined();
			expect(manager.getModelThinkingLevel("openai", "object")).toBeUndefined();
			expect(manager.getModelThinkingLevel("openai", "unknown")).toBeUndefined();
			expect(manager.getModelThinkingLevel("openai", "good")).toBe("high");
		});

		it("tolerates a non-object modelThinkingLevels value", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ modelThinkingLevels: "nope" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getModelThinkingLevel("openai", "gpt-5.5")).toBeUndefined();
		});

		it("tolerates malformed persisted last-on levels", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					modelLastOnThinkingLevels: {
						"openai/number": 3,
						"openai/off": "off",
						"openai/unknown": "ultra",
						"openai/good": "high",
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getModelLastOnThinkingLevel("openai", "number")).toBeUndefined();
			expect(manager.getModelLastOnThinkingLevel("openai", "off")).toBeUndefined();
			expect(manager.getModelLastOnThinkingLevel("openai", "unknown")).toBeUndefined();
			expect(manager.getModelLastOnThinkingLevel("openai", "good")).toBe("high");
		});

		it("preserves a concurrently written model key (nested merge)", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			// Another session writes a DIFFERENT model key between our load and our save.
			writeFileSync(
				settingsPath,
				JSON.stringify({ theme: "dark", modelThinkingLevels: { "anthropic/opus": "low" } }),
			);

			manager.setModelThinkingLevel("openai", "gpt-5.5", "xhigh");
			await manager.flush();

			const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(saved.modelThinkingLevels).toEqual({ "anthropic/opus": "low", "openai/gpt-5.5": "xhigh" });
		});

		it("preserves a concurrently written last-on key (nested merge)", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({ theme: "dark", modelLastOnThinkingLevels: { "anthropic/opus": "low" } }),
			);

			manager.setModelLastOnThinkingLevel("openai", "gpt-5.5", "xhigh");
			await manager.flush();

			expect(JSON.parse(readFileSync(settingsPath, "utf-8")).modelLastOnThinkingLevels).toEqual({
				"anthropic/opus": "low",
				"openai/gpt-5.5": "xhigh",
			});
		});

		it("does not migrate defaultThinkingLevel into the map", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "low" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getModelThinkingLevel("openai", "gpt-5.5")).toBeUndefined();
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(saved.modelThinkingLevels).toBeUndefined();
		});

		it("writes global settings only, ignoring project scope", async () => {
			const globalPath = join(agentDir, "settings.json");
			const projectPath = join(projectDir, CONFIG_DIR_NAME, "settings.json");
			writeFileSync(projectPath, JSON.stringify({ theme: "project" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setModelThinkingLevel("openai", "gpt-5.5", "medium");
			await manager.flush();

			expect(JSON.parse(readFileSync(globalPath, "utf-8")).modelThinkingLevels).toEqual({
				"openai/gpt-5.5": "medium",
			});
			expect(JSON.parse(readFileSync(projectPath, "utf-8")).modelThinkingLevels).toBeUndefined();
		});
	});

	describe("per-model service tier memory", () => {
		it("round-trips and deletes tiers per model key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getModelServiceTier("openai", "gpt-5.5")).toBeUndefined();
			manager.setModelServiceTier("openai", "gpt-5.5", "priority");
			manager.setModelServiceTier("openai", "gpt-5.5-codex", "auto");
			await manager.flush();

			expect(manager.getModelServiceTier("openai", "gpt-5.5")).toBe("priority");
			expect(manager.getModelServiceTier("openai", "gpt-5.5-codex")).toBe("auto");
			expect(JSON.parse(readFileSync(settingsPath, "utf-8")).modelServiceTiers).toEqual({
				"openai/gpt-5.5": "priority",
				"openai/gpt-5.5-codex": "auto",
			});

			manager.setModelServiceTier("openai", "gpt-5.5", undefined);
			await manager.flush();

			expect(manager.getModelServiceTier("openai", "gpt-5.5")).toBeUndefined();
			expect(JSON.parse(readFileSync(settingsPath, "utf-8")).modelServiceTiers).toEqual({
				"openai/gpt-5.5-codex": "auto",
			});
		});

		it("tolerates malformed persisted tiers", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					modelServiceTiers: { "openai/a": 1, "openai/b": null, "openai/c": "turbo", "openai/d": "flex" },
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getModelServiceTier("openai", "a")).toBeUndefined();
			expect(manager.getModelServiceTier("openai", "b")).toBeUndefined();
			expect(manager.getModelServiceTier("openai", "c")).toBeUndefined();
			expect(manager.getModelServiceTier("openai", "d")).toBe("flex");
		});

		it("preserves a concurrently written tier key (nested merge)", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({ theme: "dark", modelServiceTiers: { "openai/other": "priority" } }),
			);

			manager.setModelServiceTier("openai", "gpt-5.5", "flex");
			await manager.flush();

			expect(JSON.parse(readFileSync(settingsPath, "utf-8")).modelServiceTiers).toEqual({
				"openai/other": "priority",
				"openai/gpt-5.5": "flex",
			});
		});
	});

	describe("experimental.bashEvalOnly", () => {
		it("returns false when experimental is unset", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalBashEvalOnly()).toBe(false);
		});

		it("returns true when global experimental.bashEvalOnly is true", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { bashEvalOnly: true } }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalBashEvalOnly()).toBe(true);
		});

		it("lets project override global true to false via deep merge", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { bashEvalOnly: true } }));
			writeFileSync(
				join(projectDir, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ experimental: { bashEvalOnly: false } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalBashEvalOnly()).toBe(false);
		});

		it("lets project override global false to true via deep merge", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { bashEvalOnly: false } }));
			writeFileSync(
				join(projectDir, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ experimental: { bashEvalOnly: true } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalBashEvalOnly()).toBe(true);
		});

		it("returns false for a malformed string value without throwing on load", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { bashEvalOnly: "yes" } }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalBashEvalOnly()).toBe(false);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("experimental.workflowEvalOnly", () => {
		it("returns false when experimental is unset", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalWorkflowEvalOnly()).toBe(false);
		});

		it("returns true when global experimental.workflowEvalOnly is true", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { workflowEvalOnly: true } }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalWorkflowEvalOnly()).toBe(true);
		});

		it("lets project override global true to false via deep merge", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { workflowEvalOnly: true } }));
			writeFileSync(
				join(projectDir, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ experimental: { workflowEvalOnly: false } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalWorkflowEvalOnly()).toBe(false);
		});

		it("lets project override global false to true via deep merge", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { workflowEvalOnly: false } }));
			writeFileSync(
				join(projectDir, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ experimental: { workflowEvalOnly: true } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalWorkflowEvalOnly()).toBe(true);
		});

		it("stays independent of experimental.bashEvalOnly", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ experimental: { bashEvalOnly: true, workflowEvalOnly: false } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalBashEvalOnly()).toBe(true);
			expect(manager.getExperimentalWorkflowEvalOnly()).toBe(false);
		});

		it("returns false for a malformed string value without throwing on load", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ experimental: { workflowEvalOnly: "yes" } }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getExperimentalWorkflowEvalOnly()).toBe(false);
			expect(manager.drainErrors()).toEqual([]);
		});
	});
});

describe("routine settings keys", () => {
	const testDir = join(tmpdir(), `senpi-routine-settings-${process.pid}`);
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const settingsPath = join(agentDir, "settings.json");
	const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Parameters<
		typeof excludeRoutineOnlySettingsChanges
	>[4];

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	function classify(previous: object, next: object): string[] {
		writeFileSync(settingsPath, JSON.stringify(previous, null, 2));
		const contents = new Map<string, string>();
		refreshSettingsContentSnapshots(contents, agentDir, projectDir);
		writeFileSync(settingsPath, JSON.stringify(next, null, 2));
		return excludeRoutineOnlySettingsChanges([settingsPath], contents, agentDir, projectDir, logger);
	}

	it("suppresses reload for per-model thinking level changes", () => {
		expect(
			classify({ theme: "dark" }, { theme: "dark", modelThinkingLevels: { "openai/gpt-5.5": "xhigh" } }),
		).toEqual([]);
	});

	it("suppresses reload for per-model last-on thinking level changes", () => {
		expect(
			classify({ theme: "dark" }, { theme: "dark", modelLastOnThinkingLevels: { "openai/gpt-5.5": "xhigh" } }),
		).toEqual([]);
	});

	it("suppresses reload for per-model service tier changes", () => {
		expect(
			classify({ theme: "dark" }, { theme: "dark", modelServiceTiers: { "openai/gpt-5.5": "priority" } }),
		).toEqual([]);
	});

	it("still reloads for non-routine key changes", () => {
		expect(
			classify(
				{ modelThinkingLevels: { "openai/gpt-5.5": "xhigh" } },
				{ modelThinkingLevels: { "openai/gpt-5.5": "high" }, extensions: ["/tmp/x.ts"] },
			),
		).toEqual([settingsPath]);
	});
});

describe("SettingsManager self-write tracking", () => {
	let now = 0;

	beforeEach(() => {
		now = 0;
		__setSelfWriteTrackerClockForTests(() => now);
		__resetSelfWriteTrackerForTests();
	});

	afterEach(() => {
		__resetSelfWriteTrackerForTests();
		__setSelfWriteTrackerClockForTests();
	});

	it("records file-backed writes process-wide by their resolved settings path", async () => {
		const testDir = join(process.cwd(), "test-settings-self-write-tmp");
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });

		try {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("dark");
			manager.setDefaultModel("test-model");
			await manager.flush();

			const settingsPath = getSettingsPath(projectDir, agentDir, "global");
			const hash = createHash("sha256").update(readFileSync(settingsPath, "utf-8")).digest("hex");
			expect(wasSelfWrite(settingsPath, hash)).toBe(true);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("does not identify externally written content as a self-write", () => {
		const testDir = join(process.cwd(), "test-settings-self-write-external-tmp");
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		const settingsPath = getSettingsPath(projectDir, agentDir, "global");
		mkdirSync(agentDir, { recursive: true });

		try {
			const content = JSON.stringify({ theme: "external" });
			writeFileSync(settingsPath, content);
			expect(wasSelfWrite(settingsPath, createHash("sha256").update(content).digest("hex"))).toBe(false);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("records in-memory storage writes with the same tracker semantics", () => {
		const storage = new InMemorySettingsStorage();
		const content = JSON.stringify({ theme: "dark" });
		storage.withLock("global", () => content);

		const path = getInMemorySettingsPath("global");
		expect(wasSelfWrite(path, createHash("sha256").update(content).digest("hex"))).toBe(true);
	});

	it("retains hashes for rapid consecutive writes", async () => {
		const testDir = join(process.cwd(), "test-settings-self-write-rapid-tmp");
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });

		try {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("first");
			manager.setTheme("second");
			await manager.flush();

			const path = getSettingsPath(projectDir, agentDir, "global");
			const firstHash = createHash("sha256")
				.update(JSON.stringify({ theme: "first" }, null, 2))
				.digest("hex");
			const secondHash = createHash("sha256")
				.update(JSON.stringify({ theme: "second" }, null, 2))
				.digest("hex");
			expect(wasSelfWrite(path, firstHash)).toBe(true);
			expect(wasSelfWrite(path, secondHash)).toBe(true);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("expires entries after the tracker TTL", () => {
		const storage = new InMemorySettingsStorage();
		const content = JSON.stringify({ theme: "dark" });
		storage.withLock("global", () => content);
		now = 15_001;

		expect(wasSelfWrite(getInMemorySettingsPath("global"), createHash("sha256").update(content).digest("hex"))).toBe(
			false,
		);
	});

	it("can reset the process-wide tracker between tests", () => {
		const storage = new InMemorySettingsStorage();
		const content = JSON.stringify({ theme: "dark" });
		storage.withLock("global", () => content);
		__resetSelfWriteTrackerForTests();

		expect(wasSelfWrite(getInMemorySettingsPath("global"), createHash("sha256").update(content).digest("hex"))).toBe(
			false,
		);
	});

	it("consumes a matching hash so a later identical external edit is not suppressed", () => {
		const storage = new InMemorySettingsStorage();
		const content = JSON.stringify({ theme: "dark" });
		const hash = createHash("sha256").update(content).digest("hex");
		storage.withLock("global", () => content);

		expect(wasSelfWrite(getInMemorySettingsPath("global"), hash)).toBe(true);
		expect(wasSelfWrite(getInMemorySettingsPath("global"), hash)).toBe(false);
	});
});
