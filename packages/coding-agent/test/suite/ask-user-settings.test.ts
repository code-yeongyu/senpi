import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { collectSettingsDiagnostics } from "../../src/core/settings-diagnostics.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("askUser settings", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("defaults to enabled with a 30-minute idle timeout", () => {
		expect(SettingsManager.inMemory().getAskUserSettings()).toEqual({
			enabled: true,
			timeoutMinutes: 30,
		});
	});

	it("honors a project timeoutMinutes override", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ askUser: { enabled: true, timeoutMinutes: 30 } }));
		storage.withLock("project", () => JSON.stringify({ askUser: { timeoutMinutes: 5 } }));
		expect(SettingsManager.fromStorage(storage).getAskUserSettings()).toEqual({
			enabled: true,
			timeoutMinutes: 5,
		});
	});

	it("honors askUser.enabled false", () => {
		const manager = SettingsManager.inMemory({ askUser: { enabled: false } });
		expect(manager.getAskUserSettings()).toEqual({ enabled: false, timeoutMinutes: 30 });
	});

	it("lets --no-ask-user win over askUser.enabled true", async () => {
		expect(parseArgs(["--no-ask-user"]).unknownFlags.get("no-ask-user")).toBe(true);

		const harness = await createHarness({
			settings: { askUser: { enabled: true, timeoutMinutes: 15 } },
			extensionFactories: [{ factory: () => {} }],
			extensionFlagValues: new Map([["no-ask-user", true]]),
		});
		harnesses.push(harness);

		expect(harness.settingsManager.getAskUserSettings()).toEqual({
			enabled: false,
			timeoutMinutes: 15,
		});
		expect(harness.getExtensionRunner().createContext().getAskUserSettings?.()).toEqual({
			enabled: false,
			timeoutMinutes: 15,
		});
	});

	it("clamps timeoutMinutes to 1..120", () => {
		expect(SettingsManager.inMemory({ askUser: { timeoutMinutes: 0 } }).getAskUserSettings().timeoutMinutes).toBe(1);
		expect(SettingsManager.inMemory({ askUser: { timeoutMinutes: -8 } }).getAskUserSettings().timeoutMinutes).toBe(1);
		expect(SettingsManager.inMemory({ askUser: { timeoutMinutes: 1 } }).getAskUserSettings().timeoutMinutes).toBe(1);
		expect(SettingsManager.inMemory({ askUser: { timeoutMinutes: 120 } }).getAskUserSettings().timeoutMinutes).toBe(
			120,
		);
		expect(SettingsManager.inMemory({ askUser: { timeoutMinutes: 121 } }).getAskUserSettings().timeoutMinutes).toBe(
			120,
		);
		expect(SettingsManager.inMemory({ askUser: { timeoutMinutes: 5.9 } }).getAskUserSettings().timeoutMinutes).toBe(
			5,
		);
	});

	it("ignores a wrong-typed askUser.enabled and does not fail settings load", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ askUser: { enabled: "yes", timeoutMinutes: 12 } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
		expect(manager.getAskUserSettings()).toEqual({ enabled: true, timeoutMinutes: 12 });
	});
});
