/**
 * A run that consumed a delivery, failed on the provider and was auto-retried starts the retry with no `idle()` in
 * between, so the deliveries it consumed must be settled when the next run starts. Before this, only a crash-recovered
 * (interrupted) run was settled there, and the retried run's `idle()` settled only itself: the first run's consumed
 * records stayed open and the session reported `waiting_background` with nothing running, forever.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function lifecycle(onCustodyWrite: () => void = () => {}): SessionLifecycleController {
	const manager = SessionManager.inMemory();
	return new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: [],
		append: (record) => manager.appendCustomEntry("session-lifecycle", record),
		appendChild: (record) => manager.appendCustomEntry("child-lifecycle", record),
		appendCustody: (record) => {
			onCustodyWrite();
			manager.appendCustomEntry("work-custody", record);
		},
		emit: () => {},
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
}

function consumeDeliveryIntoCurrentRun(controller: SessionLifecycleController, key: string): void {
	const runId = controller.ledger.runId;
	if (runId === undefined) throw new Error("expected a running lifecycle run");
	const ticket = controller.obligations.open(key, "background").ticket();
	controller.obligations.queue(ticket, {
		message: { customType: "senpi-terminal", content: "SETTLE-BG-42", display: true, details: undefined },
	});
	controller.obligations.consumed(ticket, { runId, transcriptEntryId: `entry-${key}` });
}

it("settles the deliveries a provider-failed run consumed when its auto-retry starts", () => {
	const controller = lifecycle();
	controller.restoreComplete();
	controller.startRun();
	consumeDeliveryIntoCurrentRun(controller, "delivery:senpi-terminal:notification:1");

	// The provider fails and auto-retry starts the next run: no idle() in between, and the run was not interrupted.
	controller.startRun("automatic");
	controller.idle();

	expect(controller.obligations.activeCount).toBe(0);
	expect(controller.snapshot.state).toBe("done");
});

it("an AgentSession whose queued goal continuations replace each run leaves no consumed delivery open", async () => {
	const harness = await createHarness({ persistSession: true, extensionFactories: [goalExtension] });
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Keep working" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Goal ready")]),
	]);

	await harness.session.prompt("set a goal");

	const lastStateByDelivery = new Map<string, unknown>();
	for (const entry of harness.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "work-custody") continue;
		const record = entry.data as { readonly key: string; readonly state: unknown };
		lastStateByDelivery.set(record.key, record.state);
	}
	expect(lastStateByDelivery.size).toBeGreaterThan(1);
	expect([...lastStateByDelivery.values()]).not.toContain("consumed");
});

it("writes no custody record when a run starts and there is nothing to settle", () => {
	let custodyWrites = 0;
	const controller = lifecycle(() => {
		custodyWrites += 1;
	});
	controller.restoreComplete();
	controller.startRun();
	controller.idle();
	controller.startRun();
	controller.idle();

	expect(custodyWrites).toBe(0);
});
