import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ConnectionQuestionBridge, sessionQuestionBridges } from "../../../src/modes/rpc/connection-question-bridge.ts";
import type { Harness } from "../harness.ts";
import { createLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: precedence is derived from live facts rather than a turn-end verdict.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("classifies live sources by kind, with child custody ahead of background work", async () => {
	// Given a live background monitor.
	const { h, publish } = await createLifecycleHarness();
	harnesses.push(h);
	publish(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitor", activeCount: 1 });
	expect(h.session.lifecycle).toMatchObject({
		state: "waiting_background",
		waitingOn: { background: [{ source: "terminal-monitor", activeCount: 1 }] },
	});

	// When a child source is registered alongside it.
	publish(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 2, kind: "children" });

	// Then the root waits on children without losing its background obligation.
	expect(h.session.lifecycle).toMatchObject({
		state: "waiting_children",
		waitingOn: { children: 2, background: [{ source: "terminal-monitor", activeCount: 1 }] },
	});
});

it.each([
	["unattended", "held"],
	["session_hold", "paused"],
	["inherited_hold", "paused"],
	["run_fence", "paused"],
] as const)("reads a persisted %s from the shared hold ledger as %s", async (kind, state) => {
	// Given an existing keyed hold in the shared ledger.
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("session-hold", {
		op: "add",
		kind,
		key: `${kind}:test`,
		pauseSeq: 1,
		at: "2026-10-21T00:00:00.000Z",
	});

	// When the engine restores the session.
	const { h } = await createLifecycleHarness({ sessionManager: manager });
	harnesses.push(h);

	// Then it exposes the ledger's state, never a terminal state.
	expect(h.session.lifecycle).toMatchObject({
		state,
		holds: [{ kind, since: "2026-10-21T00:00:00.000Z" }],
	});
});

it("retains a human question even when an unattended hold wins precedence", async () => {
	// Given a held root and a real live question registry.
	const { h } = await createLifecycleHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(h);
	// Wired like connection-handler.ts: a registry change is the lifecycle's change edge.
	const bridge = new ConnectionQuestionBridge(() => h.session.refreshLifecycle());
	sessionQuestionBridges.set(h.session, bridge);

	// When its own human question is registered.
	const response = bridge.ask({
		requestId: "root-choice",
		waitForAnswer: true,
		timeoutMs: 30_000,
		questions: [
			{
				id: "choice",
				header: "Choice",
				question: "Which path?",
				options: [{ label: "A" }, { label: "B" }],
				multiSelect: false,
			},
		],
	});
	try {
		// Then the hold wins state but cannot hide the attention occurrence.
		expect(h.session.lifecycle).toMatchObject({
			state: "held",
			waitingOn: {
				human: [
					{
						kind: "question",
						originSessionId: h.session.sessionId,
						requestId: "root-choice",
						revision: 1,
					},
				],
			},
		});
	} finally {
		bridge.cancelAll();
		await response;
		sessionQuestionBridges.delete(h.session);
	}
});

it("reports a provider error without an armed retry as failed", async () => {
	// Given a provider response that cannot be retried.
	const { h } = await createLifecycleHarness({ settings: { retry: { enabled: false } } });
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "The provider rejected this request." }),
	]);

	// When the run ends with no other obligations.
	await runToAgentIdle(h, () => h.session.prompt("Answer the request"));

	// Then the sealed epoch carries a failure, never done.
	expect(h.session.lifecycle).toMatchObject({
		state: "failed",
		failure: { reason: "provider_error" },
		completionId: `${h.session.sessionId}:${h.session.lifecycle?.epoch}`,
	});
});
