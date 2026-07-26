import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldRunFirstTimeSetup } from "../../src/cli/startup-ui.ts";
import { APP_NAME, CONFIG_DIR_NAME, PACKAGE_NAME } from "../../src/config.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { applyGrokNeoThemeFallback } from "../../src/main.ts";
import { getResolvedThemeColors, initTheme } from "../../src/modes/interactive/theme/theme.ts";

function activateTheme(settingsManager: SettingsManager): Record<string, string> {
	initTheme(settingsManager.getTheme());
	return getResolvedThemeColors();
}

describe("grok-neo theme precedence", () => {
	it("uses grok-night in memory for a fresh startup without writing a theme", () => {
		const settingsManager = SettingsManager.inMemory();
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("grok-night");
		expect(settingsManager.getGlobalSettings()).not.toHaveProperty("theme");
		expect(activateTheme(settingsManager)).toEqual(getResolvedThemeColors("grok-night"));
	});

	it("keeps an existing settings theme", () => {
		const settingsManager = SettingsManager.inMemory({ theme: "dark" });
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("dark");
		expect(activateTheme(settingsManager)).toEqual(getResolvedThemeColors("dark"));
	});

	it("keeps grok-day when settings explicitly select it", () => {
		const settingsManager = SettingsManager.inMemory({ theme: "grok-day" });
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("grok-day");
		expect(activateTheme(settingsManager)).toEqual(getResolvedThemeColors("grok-day"));
	});

	it("keeps a custom user theme selection", () => {
		const settingsManager = SettingsManager.inMemory({ theme: "my-custom-theme" });
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("my-custom-theme");
	});

	it("keeps an explicit session selection after settings reload", async () => {
		const settingsManager = SettingsManager.inMemory();
		applyGrokNeoThemeFallback(settingsManager);
		settingsManager.setTheme("grok-day");
		await settingsManager.flush();
		await settingsManager.reload();

		expect(settingsManager.getThemeSetting()).toBe("grok-day");
	});
});

describe("grok-neo startup in the senpi distribution", () => {
	it("does not enter first-time setup under the package's real identity", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "senpi-grok-neo-startup-"));
		try {
			expect({ packageName: PACKAGE_NAME, appName: APP_NAME, configDirName: CONFIG_DIR_NAME }).toEqual({
				packageName: "@code-yeongyu/senpi",
				appName: "senpi",
				configDirName: ".senpi",
			});
			expect(shouldRunFirstTimeSetup(join(sandbox, "settings.json"))).toBe(false);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("activates grok-night in memory without persisting a fresh sandbox theme", async () => {
		const sandbox = mkdtempSync(join(tmpdir(), "senpi-grok-neo-startup-"));
		const agentDir = join(sandbox, "agent");
		const settingsManager = SettingsManager.create(join(sandbox, "work"), agentDir);
		try {
			applyGrokNeoThemeFallback(settingsManager);

			expect(settingsManager.getThemeSetting()).toBe("grok-night");
			expect(activateTheme(settingsManager)).toEqual(getResolvedThemeColors("grok-night"));

			settingsManager.setEnableAnalytics(true);
			await settingsManager.flush();

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			expect(settings).not.toHaveProperty("theme");
			expect(settings).toMatchObject({ enableAnalytics: true });
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
