import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../harness.ts";

// A switch that persists the default model must leave the new value on disk
// before it resolves. `SettingsManager.save()` queues the write and returns, so
// without an awaited flush a Ctrl+S / `/model <id> --default` selection followed
// by an immediate quit kept the previous `defaultModel` in settings.json and the
// next session opened on the old model.

const MODELS = [
	{ id: "main", name: "Main", reasoning: true },
	{ id: "other", name: "Other", reasoning: true },
];

function other(harness: Harness) {
	const model = harness.getModel("other");
	if (model === undefined) throw new Error("missing fixture model");
	return model;
}

function settingsOnDisk(harness: Harness): { defaultModel?: string; defaultProvider?: string } {
	return JSON.parse(readFileSync(join(harness.session.agentDir, "settings.json"), "utf8")) as {
		defaultModel?: string;
		defaultProvider?: string;
	};
}

describe("a persisted default model is durable before the switch resolves", () => {
	beforeAll(() => initTheme("dark"));
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("setModel flushes the settings write and leaves the new default on disk", async () => {
		const harness = await createHarness({
			models: MODELS,
			fileSettings: true,
			settings: { defaultModel: "main" },
		});
		harnesses.push(harness);
		const flush = vi.spyOn(harness.settingsManager, "flush");

		await harness.session.setModel(other(harness));

		expect(flush).toHaveBeenCalled();
		expect(settingsOnDisk(harness).defaultModel).toBe("other");
		// A brand-new manager over the same agent dir (what the next session does) sees it too.
		const reloaded = SettingsManager.create(harness.tempDir, harness.session.agentDir);
		await reloaded.flush();
		expect(reloaded.getDefaultModel()).toBe("other");
	});

	it("cycleModel flushes the settings write and leaves the new default on disk", async () => {
		const harness = await createHarness({
			models: MODELS,
			fileSettings: true,
			settings: { defaultModel: "main" },
		});
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: other(harness) }]);
		const flush = vi.spyOn(harness.settingsManager, "flush");

		await harness.session.cycleModel("forward");

		expect(harness.session.model?.id).toBe("other");
		expect(flush).toHaveBeenCalled();
		expect(settingsOnDisk(harness).defaultModel).toBe("other");
	});

	it("a session-scoped switch neither flushes nor rewrites the default", async () => {
		const harness = await createHarness({
			models: MODELS,
			fileSettings: true,
			settings: { defaultModel: "main" },
		});
		harnesses.push(harness);
		const flush = vi.spyOn(harness.settingsManager, "flush");

		await harness.session.setSessionModel(other(harness));

		expect(flush).not.toHaveBeenCalled();
		expect(settingsOnDisk(harness).defaultModel).toBe("main");
	});
});
