import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	REASONING_LEVEL_TIP_ID,
	resolveReasoningLevelNotice,
} from "../src/modes/interactive/tips/reasoning-level-notice.ts";

const keys = (binding: string): string => (binding === "app.thinking.cycle" ? "Shift+Tab" : "");

describe("one-time reasoning level notice (senpi#3090)", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "senpi-3090-notice-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("names the bound key and the reasoning level the first time", () => {
		const notice = resolveReasoningLevelNotice({ history: {}, modelReasoning: true, keys });
		expect(notice).toEqual({ tipId: REASONING_LEVEL_TIP_ID, line: "Tip: Shift+Tab changes the reasoning level" });
	});

	it("is shown once and never again after a restart of the settings store", async () => {
		const first = SettingsManager.create(agentDir, agentDir);
		const notice = resolveReasoningLevelNotice({ history: first.getTipsHistory(), modelReasoning: true, keys });
		expect(notice).toBeDefined();
		first.setTipShown(REASONING_LEVEL_TIP_ID, 1_700_000_000_000);
		await first.flush();

		const sameRun = resolveReasoningLevelNotice({ history: first.getTipsHistory(), modelReasoning: true, keys });
		expect(sameRun).toBeUndefined();

		const restarted = SettingsManager.create(agentDir, agentDir);
		const afterRestart = resolveReasoningLevelNotice({
			history: restarted.getTipsHistory(),
			modelReasoning: true,
			keys,
		});
		expect(afterRestart).toBeUndefined();
	});

	it("is never shown for a model without reasoning", () => {
		expect(resolveReasoningLevelNotice({ history: {}, modelReasoning: false, keys })).toBeUndefined();
	});

	it("is not shown when the cycle action is unbound", () => {
		expect(resolveReasoningLevelNotice({ history: {}, modelReasoning: true, keys: () => "" })).toBeUndefined();
	});
});
