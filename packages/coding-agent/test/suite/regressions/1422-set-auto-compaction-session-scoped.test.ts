import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionSettings } from "../../../src/core/compaction-settings-access.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// Issue #1422: the per-session `set_auto_compaction` command (OmO Desktop's
// per-thread toggle rides on it) used to rewrite the persisted global setting
// and silently disabled auto-compaction for every other session on the host.

function readPersistedCompaction(harness: Harness): CompactionSettings | undefined {
	const raw: unknown = JSON.parse(readFileSync(join(harness.tempDir, "agent", "settings.json"), "utf8"));
	if (typeof raw !== "object" || raw === null || !("compaction" in raw)) return undefined;
	const compaction: unknown = raw.compaction;
	if (typeof compaction !== "object" || compaction === null) return undefined;
	return compaction;
}

describe("#1422 set_auto_compaction is session-scoped", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("applies the toggle to this session without rewriting the persisted setting", async () => {
		//#given - a session whose settings live on disk with auto-compaction enabled
		const harness = await createHarness({
			fileSettings: true,
			settings: { compaction: { enabled: true, reserveTokens: 2_048 } },
		});
		harnesses.push(harness);

		//#when - the session-level command switches auto-compaction off
		harness.session.setAutoCompactionEnabled(false);

		//#then - this session reports the toggle
		expect(harness.session.autoCompactionEnabled).toBe(false);
		expect(harness.eventsOfType("session_settings_changed").at(-1)).toMatchObject({ autoCompactionEnabled: false });

		//#then - the persisted global setting is untouched, on disk and through a fresh reader
		expect(readPersistedCompaction(harness)).toEqual({ enabled: true, reserveTokens: 2_048 });
		expect(harness.settingsManager.getCompactionEnabled()).toBe(true);
		const freshReader = SettingsManager.create(harness.tempDir, join(harness.tempDir, "agent"));
		expect(freshReader.getCompactionEnabled()).toBe(true);
	});

	it("exposes the session toggle to extensions through getCompactionSettings", async () => {
		//#given
		const observed: boolean[] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: true } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async (_event, ctx) => {
						observed.push(ctx.getCompactionSettings().enabled);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		//#when
		harness.session.setAutoCompactionEnabled(false);
		await harness.session.prompt("hello");

		//#then - the builtin compaction policy reads the same value the session reports
		expect(observed).toEqual([false]);
	});

	it("lets a session opt back in while the persisted setting stays off", async () => {
		//#given
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		expect(harness.session.autoCompactionEnabled).toBe(false);

		//#when - the session opts back in
		harness.session.setAutoCompactionEnabled(true);

		//#then
		expect(harness.session.autoCompactionEnabled).toBe(true);
		expect(harness.settingsManager.getCompactionEnabled()).toBe(false);
	});
});
