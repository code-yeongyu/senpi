import { expect, it } from "vitest";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import type { SessionLifecycleEvent } from "../../../src/core/session-lifecycle-types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

it("keeps live custody when writes fail and flushes it before a durable lifecycle publication", () => {
	const manager = SessionManager.inMemory();
	const events: SessionLifecycleEvent[] = [];
	let writable = true;
	const controller = new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: [],
		append: (record) => manager.appendCustomEntry("session-lifecycle", record),
		appendChild: (record) => manager.appendCustomEntry("child-lifecycle", record),
		appendCustody: (record) => {
			if (!writable) throw new Error("EACCES: custody write refused");
			manager.appendCustomEntry("work-custody", record);
		},
		emit: (event) => events.push(event),
		readRuntime: () => ({
			activity: {
				isStreaming: false,
				isBashRunning: false,
				isCompacting: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			holds: [],
			human: [],
		}),
	});
	controller.restoreComplete();
	controller.startRun();
	writable = false;
	const source = controller.obligations.open("result:review", "children");
	source.ticket();
	controller.idle();
	expect(controller.obligations.activeCount).toBe(1);
	expect(controller.snapshot).toMatchObject({
		state: "waiting_children",
		persisted: false,
		selfSettleEligible: false,
	});
	expect(events.at(-1)?.lifecycle.persisted).toBe(false);
	expect(controller.requestSelfSettle().recorded).toBe(false);

	writable = true;
	expect(controller.snapshot).toMatchObject({ state: "waiting_children", persisted: true });
	const entries = manager.getEntries();
	const custody = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === "work-custody");
	const lifecycle = entries.findLastIndex(
		(entry) => entry.type === "custom" && entry.customType === "session-lifecycle",
	);
	expect(custody).toBeGreaterThanOrEqual(0);
	expect(custody).toBeLessThan(lifecycle);
	source.close("cancelled");
	expect(controller.snapshot).toMatchObject({ state: "done", persisted: true });
});
