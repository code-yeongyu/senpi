import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { resumeRuntime } from "../issue-1473-runtime-support.ts";

// PR #1473 must preserve upstream 60c436d40 while cleaning up genuinely rejected candidates.
it.each([
	{ name: "compactable context", size: 60_000, enabled: true, accepted: true },
	{ name: "context beyond model window", size: 70_000, enabled: true, accepted: false },
	{ name: "disabled compaction", size: 60_000, enabled: false, accepted: false },
])("PR1473 upstream: preserves admission for $name", async ({ size, enabled, accepted }) => {
	let vetoes = 0;
	const host = await resumeRuntime((pi) => {
		pi.on("session_before_switch", () => {
			vetoes++;
		});
	}, 65_536);
	try {
		writeFileSync(join(host.cwd, "settings.json"), JSON.stringify({ compaction: { enabled } }));
		const target = SessionManager.create(host.cwd, join(host.cwd, "targets"));
		target.appendMessage({ role: "user", content: "x".repeat(size), timestamp: 0 });
		target.appendMessage(fauxAssistantMessage("stored"));
		const path = target.getSessionFile();
		if (!path) throw new Error("Persistent fixture has no session file");
		const before = readFileSync(path);
		const original = host.runtime.session;

		if (accepted) {
			await expect(host.runtime.switchSession(path)).resolves.toEqual({ cancelled: false });
			expect(host.runtime.session).not.toBe(original);
			expect(host.runtime.session.sessionFile).toBe(path);
			const events: unknown[] = [];
			const unsubscribe = host.runtime.session.subscribe((event) => events.push(event));
			unsubscribe();
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "resume_compaction_required",
					projection: expect.objectContaining({ admission: "resume", usable: false }),
				}),
			);
			expect(vetoes).toBe(1);
		} else {
			await expect(host.runtime.switchSession(path)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
			expect(host.runtime.session).toBe(original);
			expect(vetoes).toBe(0);
			expect(readFileSync(path)).toEqual(before);
		}
	} finally {
		await host.dispose();
	}
});
