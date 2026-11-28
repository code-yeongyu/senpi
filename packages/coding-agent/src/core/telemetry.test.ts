import { describe, expect, it } from "vitest";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

function settingsWith(enableInstallTelemetry: boolean): SettingsManager {
	return { getEnableInstallTelemetry: () => enableInstallTelemetry } as unknown as SettingsManager;
}

describe("isInstallTelemetryEnabled", () => {
	it("DO_NOT_TRACK=1 disables install telemetry even when the setting is on", () => {
		expect(isInstallTelemetryEnabled(settingsWith(true), undefined, { DO_NOT_TRACK: "1" })).toBe(false);
	});

	it("OMO_DISABLE_TELEMETRY=1 disables install telemetry even when the setting is on", () => {
		expect(isInstallTelemetryEnabled(settingsWith(true), undefined, { OMO_DISABLE_TELEMETRY: "1" })).toBe(false);
	});

	it("DO_NOT_TRACK=0 leaves the setting in charge", () => {
		expect(isInstallTelemetryEnabled(settingsWith(true), undefined, { DO_NOT_TRACK: "0" })).toBe(true);
		expect(isInstallTelemetryEnabled(settingsWith(false), undefined, { DO_NOT_TRACK: "0" })).toBe(false);
	});

	it("a falsey OMO_DISABLE_TELEMETRY leaves the setting in charge", () => {
		expect(isInstallTelemetryEnabled(settingsWith(true), undefined, { OMO_DISABLE_TELEMETRY: "false" })).toBe(true);
	});

	it("the brand TELEMETRY env value still wins over the setting", () => {
		expect(isInstallTelemetryEnabled(settingsWith(true), "0", {})).toBe(false);
		expect(isInstallTelemetryEnabled(settingsWith(false), "1", {})).toBe(true);
	});

	it("an unset env keeps the setting", () => {
		expect(isInstallTelemetryEnabled(settingsWith(true), undefined, {})).toBe(true);
		expect(isInstallTelemetryEnabled(settingsWith(false), undefined, {})).toBe(false);
	});
});
