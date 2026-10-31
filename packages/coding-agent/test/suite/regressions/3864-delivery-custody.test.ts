import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import {
	createBoundLifecycleHarness as createHarness,
	nextSessionEvent,
	runToAgentIdle,
} from "../lifecycle-test-harness.ts";

// senpi#3864: a ticket's work stays owned until its model-consuming run idles.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("consumes a queued wake into a new turn before sealing root work", async () => {
	// Given the final child has transferred custody to its queued result.
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.workObligations).toBeDefined();
	const source = h.session.workObligations.open("task:review", "children");
	const queued = source.transfer("omo-wake-queue:review");
	const ticket = queued.ticket();
	h.setResponses([fauxAssistantMessage("The review is incorporated.")]);

	// When the engine delivers and consumes the result.
	await runToAgentIdle(h, () =>
		h.session.sendCustomMessage(
			{ customType: "senpi-task.completion", content: "Review passed.", display: false },
			{ triggerTurn: true, ticket },
		),
	);

	// Then custody records the consuming run and only its idle settles the work.
	const records = h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "work-custody");
	expect(records).toContainEqual(
		expect.objectContaining({
			data: expect.objectContaining({
				state: "consumed",
				ticketId: ticket,
				runId: expect.any(String),
				transcriptEntryId: expect.any(String),
			}),
		}),
	);
	expect(records).toContainEqual(
		expect.objectContaining({ data: expect.objectContaining({ state: "settled", ticketId: ticket }) }),
	);
	expect(h.session.workObligations.activeCount).toBe(0);
	expect(
		h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
	).toHaveLength(1);
});

it("keeps a failed admission in producer custody instead of falsely completing", async () => {
	// Given a queued wake whose provider admission cannot succeed.
	const h = await createHarness({ withConfiguredAuth: false });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.workObligations).toBeDefined();
	const queued = h.session.workObligations.open("omo-wake-queue:review", "children");
	const ticket = queued.ticket();

	// When delivery fails before model consumption.
	await expect(
		h.session.sendCustomMessage(
			{ customType: "senpi-task.completion", content: "Review passed.", display: false },
			{ triggerTurn: true, ticket },
		),
	).rejects.toThrow();

	// Then failure never releases the result's obligation.
	expect(h.session.workObligations.activeCount).toBe(1);
	expect(h.session.lifecycle).toMatchObject({ state: "waiting_children" });
	expect(
		h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
	).toHaveLength(0);
	queued.close("cancelled");
});

it("acknowledges a steer in the existing run without needing another agent_start", async () => {
	// Given a root run blocked at a deterministic tool barrier.
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const startedSignal = AbortSignal.timeout(10_000);
	startedSignal.addEventListener("abort", () => started.reject(startedSignal.reason), { once: true });
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for the test's release signal",
		parameters: Type.Object({}),
		execute: async () => {
			started.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const h = await createHarness({ persistSession: true, tools: [tool] });
	harnesses.push(h);
	expect(h.session.workObligations).toBeDefined();
	const child = h.session.workObligations.open("task:review", "children");
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("The review is incorporated."),
	]);
	const idle = nextSessionEvent(h, (event) => event.type === "agent_idle");
	const run = h.session.prompt("Work while the review runs");
	void run.catch(started.reject);
	try {
		await started.promise;
		const queued = child.transfer("omo-wake-queue:review");
		const ticket = queued.ticket();

		// When the last child's result is steered into this already-running turn.
		await h.session.sendCustomMessage(
			{ customType: "senpi-task.completion", content: "Review passed.", display: false },
			{ deliverAs: "steer", triggerTurn: true, ticket },
		);
		release.resolve();
		await run;
		await idle;

		// Then the same consuming run owns the result until one final seal.
		expect(h.events.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(h.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "work-custody",
				data: expect.objectContaining({ state: "consumed", ticketId: ticket }),
			}),
		);
		expect(h.session.workObligations.activeCount).toBe(0);
		expect(
			h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
		).toHaveLength(1);
	} finally {
		release.resolve();
		await run;
	}
});
