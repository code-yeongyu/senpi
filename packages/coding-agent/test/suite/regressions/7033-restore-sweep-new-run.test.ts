import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7033: a session that exited cleanly reopened under the interrupted-run hold when a restored monitor fired while
// the session was still restoring. The restore sweep read the custody record of the run that wake had just opened and
// marked it INTERRUPTED (host_restart), so every later peer delivery was held. Only work open before the restart is
// work a restart can have interrupted.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function cleanlyExitedSession(): Promise<{ base: Harness; file: string }> {
	const base = await createHarness({ persistSession: true });
	cleanups.push(base.cleanup);
	base.sessionManager.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
	base.sessionManager.appendMessage(fauxAssistantMessage("Done for now"));
	const file = base.sessionManager.getSessionFile();
	if (!file) throw new Error("the session has no file");
	return { base, file };
}

function settled(h: Harness): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			unsubscribe();
			resolve();
		});
	});
}

it("a wake that runs while the reopened session restores is not recorded as an interrupted run", async () => {
	const { base, file } = await cleanlyExitedSession();
	// The restored monitor's first line, sent while the session binds its extensions: the turn it triggers starts
	// without waiting for the restore, as in the reported file (the run began 1.2 s before the sweep).
	const monitor: ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			void pi.sendMessage(
				{ customType: "senpi-monitor:notification", content: "restored after up to 19s offline", display: false },
				{ triggerTurn: true },
			);
		});
	};
	const h = await createHarness({
		siblingOf: base,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: { type: "session_start", reason: "resume", attended: true },
		extensionFactories: [monitor],
	});
	cleanups.push(h.cleanup);
	const requested = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<void>();
	h.setResponses([
		async () => {
			requested.resolve();
			await answer.promise;
			return fauxAssistantMessage([fauxText("the restored watch reported")]);
		},
		fauxAssistantMessage([fauxText("continued")]),
	]);

	const woke = settled(h);
	const binding = h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await requested.promise;
	// The run is still working when the binding's restore sweep reads custody; it ends normally afterwards.
	await binding;
	answer.resolve();
	await woke;

	const entries = h.sessionManager.getEntries();
	expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "interrupted-run")).toEqual([]);
	expect(h.session.holds.map((hold) => hold.key)).not.toContain("interrupted-run");

	const after = settled(h);
	expect(
		h.session.externalAdmission.admit({ delivery_id: "peer-1", text: "[from lead] continue", deliverAs: "followUp" }),
	).toMatchObject({ kind: "started" });
	await after;
	expect(h.session.paused).toBe(false);
});
