import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("idleCompactionEnabled setting", () => {
	it("defaults to true", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getCompactionSettings().idleCompactionEnabled).toBe(true);
	});

	it("respects false when explicitly set", () => {
		const sm = SettingsManager.inMemory({ compaction: { idleCompactionEnabled: false } });
		expect(sm.getCompactionSettings().idleCompactionEnabled).toBe(false);
	});
});

describe("compaction model override setting", () => {
	it("defaults to undefined", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getCompactionSettings().model).toBeUndefined();
	});

	it("passes through a configured provider/model override", () => {
		const sm = SettingsManager.inMemory({ compaction: { model: "deepseek/deepseek-chat" } });
		expect(sm.getCompactionSettings().model).toBe("deepseek/deepseek-chat");
	});
});

describe("compaction summarizationMaxDurationMs setting", () => {
	it("defaults to undefined so the size-adaptive budget applies", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getCompactionSettings().summarizationMaxDurationMs).toBeUndefined();
	});

	it("passes through a configured positive override", () => {
		const sm = SettingsManager.inMemory({ compaction: { summarizationMaxDurationMs: 600_000 } });
		expect(sm.getCompactionSettings().summarizationMaxDurationMs).toBe(600_000);
	});

	it("ignores non-positive and non-finite values", () => {
		for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const sm = SettingsManager.inMemory({ compaction: { summarizationMaxDurationMs: value } });
			expect(sm.getCompactionSettings().summarizationMaxDurationMs).toBeUndefined();
		}
	});
});
