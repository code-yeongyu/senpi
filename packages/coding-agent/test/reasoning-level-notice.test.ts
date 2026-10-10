import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	REASONING_LEVEL_TIP_ID,
	resolveReasoningLevelNotice,
} from "../src/modes/interactive/tips/reasoning-level-notice.ts";

const keys = (binding: string): string => (binding === "app.thinking.cycle" ? "Shift+Tab" : "");
const NOTICE = "Tip: Shift+Tab changes the reasoning level";

describe("resolveReasoningLevelNotice", () => {
	it("names the bound key and the reasoning level the first time", () => {
		const notice = resolveReasoningLevelNotice({ history: {}, modelReasoning: true, keys });
		expect(notice).toEqual({ tipId: REASONING_LEVEL_TIP_ID, line: NOTICE });
	});

	it("is never shown for a model without reasoning", () => {
		expect(resolveReasoningLevelNotice({ history: {}, modelReasoning: false, keys })).toBeUndefined();
	});

	it("is not shown when the cycle action is unbound", () => {
		expect(resolveReasoningLevelNotice({ history: {}, modelReasoning: true, keys: () => "" })).toBeUndefined();
	});
});

/**
 * The production startup-tip path (`InteractiveMode.resolveStartupTips`) run against a real
 * `SettingsManager` on a temp agent dir: it must record the notice itself, never repeat it after a
 * restart, skip the rotating `thinking-level` tip on the launch the notice shows, and obey the
 * `tips` and `quietStartup` settings.
 */
describe("one-time reasoning level notice through the startup header (senpi#3090)", () => {
	let agentDir: string;

	beforeAll(() => setKeybindings(new KeybindingsManager()));
	afterAll(() => setKeybindings(new KeybindingsManager()));

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "senpi-3090-notice-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function startupTips(settingsManager: SettingsManager, reasoning: boolean): string | undefined {
		const resolve = Reflect.get(InteractiveMode.prototype, "resolveStartupTips");
		const record = Reflect.get(InteractiveMode.prototype, "recordShownTip");
		if (typeof resolve !== "function" || typeof record !== "function") {
			throw new TypeError("InteractiveMode lost its startup tip path");
		}
		const host = {
			settingsManager,
			session: { state: { model: { reasoning } } },
			sessionShownTipIds: new Set<string>(),
			hasRegisteredCommand: () => false,
			recordShownTip: record,
		};
		const tips: unknown = resolve.call(host);
		return typeof tips === "string" ? tips : undefined;
	}

	it("shows the notice once, skips the rotating thinking-level tip that launch, and never repeats after a restart", async () => {
		const first = SettingsManager.create(agentDir, agentDir);
		const firstLaunch = startupTips(first, true);
		expect(firstLaunch).toContain(NOTICE);
		expect(firstLaunch).not.toContain("/thinking <level>");
		expect(first.getTipsHistory()).toHaveProperty(REASONING_LEVEL_TIP_ID);
		expect(first.getTipsHistory()).not.toHaveProperty("thinking-level");
		await first.flush();

		const restarted = SettingsManager.create(agentDir, agentDir);
		expect(restarted.getTipsHistory()).toHaveProperty(REASONING_LEVEL_TIP_ID);
		const secondLaunch = startupTips(restarted, true);
		expect(secondLaunch).toBeDefined();
		expect(secondLaunch).not.toContain(NOTICE);
	});

	it("shows nothing about the reasoning level for a model without reasoning", () => {
		const settings = SettingsManager.create(agentDir, agentDir);
		const tips = startupTips(settings, false);
		expect(tips ?? "").not.toContain(NOTICE);
		expect(settings.getTipsHistory()).not.toHaveProperty(REASONING_LEVEL_TIP_ID);
	});

	it("respects tips=false and a quiet startup, and records nothing then", () => {
		const tipsOff = SettingsManager.inMemory({ tips: false });
		expect(startupTips(tipsOff, true)).toBeUndefined();
		expect(tipsOff.getTipsHistory()).not.toHaveProperty(REASONING_LEVEL_TIP_ID);

		const quiet = SettingsManager.inMemory({ quietStartup: "header" });
		expect(startupTips(quiet, true)).toBeUndefined();
		expect(quiet.getTipsHistory()).not.toHaveProperty(REASONING_LEVEL_TIP_ID);
	});
});
