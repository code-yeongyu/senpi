import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import { nextSessionEvent, runToAgentIdle } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";
import { makeSink, MockAssistantStream } from "../rpc-connection-harness.ts";

// senpi#3864: the real RPC surface owns revisions and decisions, not a client's projection.
type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});

it("advertises lifecycle and returns the exact shared snapshot through get_state", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	const client = fixture.bind();
	const protocol = await client.send({ type: "get_protocol_info" });
	expect(protocol).toMatchObject({
		success: true,
		data: { capabilities: expect.arrayContaining(["session_lifecycle"]) },
	});
	const state = await client.send({ type: "get_state" });
	expect(state).toMatchObject({ success: true, data: { lifecycle: fixture.session.lifecycle } });
	expect((state.data as { lifecycle: object }).lifecycle).not.toHaveProperty("runId");
});

// senpi#4925: real session/RPC delivery must correlate starts, snapshots, and readback, not observation order.
it("correlates each start with its snapshots and keeps idle snapshots on the preceding run", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	const client = fixture.bind();
	const child = fixture.session.workObligations.open("task:pending", "children");
	fixture.harness.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")]);
	const ids: string[] = [];
	for (const message of ["First", "Second"]) {
		const offset = client.messages().length;
		await runToAgentIdle(fixture, () => client.send({ type: "prompt", message }));
		const records = client.messages().slice(offset);
		const start = records.find((record) => record.type === "agent_start");
		expect(start?.runId).toEqual(expect.any(String));
		const runId = start?.runId as string;
		ids.push(runId);
		const snapshots = records.filter((record) => record.type === "session_lifecycle");
		expect(snapshots.length).toBeGreaterThan(0);
		for (const snapshot of snapshots) expect(snapshot.lifecycle).toHaveProperty("runId", runId);
		expect(await client.send({ type: "get_state" })).toMatchObject({ data: { lifecycle: { runId } } });
		if (message === "First") {
			const idle = nextSessionEvent(fixture, (event) => event.type === "session_lifecycle");
			child.close("cancelled");
			expect(await idle).toMatchObject({ lifecycle: { runId } });
		}
	}
	expect(ids[1]).not.toBe(ids[0]);
});

it("persists a second human client's revision before input and invalidates a standing settle request", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	const first = fixture.bind();
	const second = fixture.bind();
	await first.send({ type: "set_client_info", capabilities: ["interactive_user"] });
	await second.send({ type: "set_client_info", capabilities: ["interactive_user"] });
	const child = fixture.session.workObligations.open("task:review", "children");
	fixture.harness.setResponses([
		fauxAssistantMessage("Waiting for review."),
		fauxAssistantMessage("Review incorporated."),
	]);
	await runToAgentIdle(fixture, () => first.send({ type: "prompt", message: "Do this work." }));
	const epoch = fixture.session.lifecycle.epoch;
	expect(await first.send({ type: "request_self_settle" })).toMatchObject({
		success: true,
		data: { recorded: true, epoch, humanInputRevision: 1 },
	});
	const revision = nextSessionEvent(
		fixture.harness,
		(event) => event.type === "session_lifecycle" && event.lifecycle.humanInputRevision === 2,
	);
	await second.send({ type: "steer", message: "Consider this too." });
	expect(await revision).toMatchObject({ lifecycle: { epoch, humanInputRevision: 2, persisted: true } });
	const persisted = fixture.harness.sessionManager
		.getEntries()
		.findLast((entry) => entry.type === "custom" && entry.customType === "session-lifecycle");
	expect(persisted).toMatchObject({ data: { humanInputRevision: 2 } });
	await runToAgentIdle(fixture, () => fixture.session.prompt("Consume the queued steer.", { source: "extension" }));
	child.close("cancelled");
	expect(fixture.session.lifecycle).toMatchObject({ state: "done", humanInputRevision: 2 });
	expect(fixture.session.lifecycle.settleDecision).toBeUndefined();
});

it("broadcasts lifecycle to unattached observers and replays only the latest snapshot", async () => {
	const fanout = new SessionEventFanout();
	const observer = makeSink();
	fanout.registerConnection("observer", observer.sink);
	try {
		expect(fanout.targets("root", undefined, false, "session_lifecycle")).toContain("observer");
		const base: SessionLifecycle = {
			state: "running",
			seq: 1,
			epoch: 1,
			epochOrigin: "human",
			humanInputRevision: 1,
			selfSettleEligible: true,
			restoring: false,
			persisted: true,
			runPaused: false,
			since: "2026-10-21T00:00:00.000Z",
			role: "root",
			rootSessionId: "root",
		};
		for (const lifecycle of [base, { ...base, seq: 2, state: "done" }]) {
			const event = { type: "session_lifecycle", sessionId: "root", lifecycle };
			fanout.rememberSnapshot("root", event, `${JSON.stringify(event)}\n`);
		}
		const replayed = observer.waitFor((record) => record.type === "session_lifecycle", 10_000);
		fanout.attachConnectionToSession("observer", "root");
		expect(await replayed).toMatchObject({ lifecycle: { seq: 2, state: "done" } });
		expect(observer.messages().filter((record) => record.type === "session_lifecycle")).toHaveLength(1);
	} finally {
		fanout.unregisterConnection("observer");
	}
});

it("restores the post-steer revision when no lifecycle projection was read before restart", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	fixture.harness.setResponses([fauxAssistantMessage("Reply.")]);
	const client = fixture.bind();
	await client.send({ type: "set_client_info", capabilities: ["interactive_user"] });
	await runToAgentIdle(fixture, () => client.send({ type: "prompt", message: "Start." }));
	await client.send({ type: "steer", message: "A new instruction, not a new run." });
	await fixture.reopenAbandoned();
	await fixture.session.bindExtensions({ mode: "rpc" });
	expect(fixture.session.lifecycle.humanInputRevision).toBe(2);
});

it.each(["a", "b"] as const)(
	"publishes overlapping tools through RPC when %s ends first, excluding nested calls",
	async (firstEnd) => {
		const gates = { a: Promise.withResolvers<void>(), b: Promise.withResolvers<void>() };
		const fixture = await createIdentityHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "nested",
						label: "nested",
						description: "Nested operation",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
					for (const name of ["a", "b"] as const)
						pi.registerTool({
							name,
							label: name,
							description: "Controlled parallel operation",
							parameters: Type.Object({}),
							execute: async (_id, _params, _signal, _onUpdate, ctx) => {
								await ctx.executeTool("nested", {});
								await gates[name].promise;
								return { content: [], details: {} };
							},
						});
				},
			],
		});
		fixtures.push(fixture);
		await fixture.session.bindExtensions({ mode: "rpc" });
		const client = fixture.bind();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("a", {}), fauxToolCall("b", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const bothStarted = nextSessionEvent(
			fixture,
			(event) => event.type === "tool_execution_start" && event.toolName === "b",
		);
		const run = runToAgentIdle(fixture, () => fixture.session.prompt("Run both."));
		try {
			await bothStarted;
			const first = fixture.session.lifecycle;
			expect(first.activity).toMatchObject({ kind: "tool", toolName: "a", outstanding: 2 });
			const ended = nextSessionEvent(
				fixture,
				(event) => event.type === "tool_execution_end" && event.toolName === firstEnd && !event.parentToolCallId,
			);
			gates[firstEnd].resolve();
			await ended;
			const remaining = fixture.session.lifecycle;
			expect(remaining.activity).toMatchObject({
				kind: "tool",
				toolName: firstEnd === "a" ? "b" : "a",
				outstanding: 1,
			});
			const wire = client.messages().filter((record) => record.type === "session_lifecycle");
			const activities = wire
				.map((record) => record.lifecycle as SessionLifecycle)
				.filter((lifecycle) => lifecycle.activity?.kind === "tool");
			expect(
				activities.map((lifecycle) => lifecycle.activity?.kind === "tool" && lifecycle.activity.outstanding),
			).toEqual([1, 2, 1]);
			expect(activities.map((lifecycle) => lifecycle.seq)).toEqual(Array(3).fill(first.seq));
			const revision = activities[0].activityRevision;
			expect(revision).toBeDefined();
			expect(activities.map((lifecycle) => lifecycle.activityRevision)).toEqual(
				[0, 1, 2].map((offset) => ({
					instanceId: revision?.instanceId,
					revision: (revision?.revision ?? 0) + offset,
				})),
			);
			if (firstEnd === "b")
				expect(activities.map((lifecycle) => lifecycle.activity?.since)).toEqual(
					Array(3).fill(first.activity?.since),
				);
			expect(await client.send({ type: "get_state" })).toMatchObject({ data: { lifecycle: remaining } });
		} finally {
			gates.a.resolve();
			gates.b.resolve();
			await run;
		}
		expect(fixture.session.lifecycle.activity).toBeUndefined();
	},
);

it("waits for the assistant stream start and clears activity on rebinding", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	const requested = Promise.withResolvers<void>();
	const stream = new MockAssistantStream();
	fixture.harness.agent.streamFunction = () => {
		requested.resolve();
		return stream;
	};
	const run = runToAgentIdle(fixture, () => fixture.session.prompt("Wait for the stream."));
	try {
		await requested.promise;
		expect(fixture.session.lifecycle).toMatchObject({ state: "running" });
		expect(fixture.session.lifecycle.activity).toBeUndefined();
		const message = fauxAssistantMessage("Streaming");
		const started = nextSessionEvent(
			fixture,
			(event) => event.type === "message_start" && event.message.role === "assistant",
		);
		stream.push({ type: "start", partial: message });
		await started;
		expect(fixture.session.lifecycle.activity).toMatchObject({ kind: "model" });
		const oldOwner = fixture.session.lifecycle.activityRevision?.instanceId;
		expect(oldOwner).toEqual(expect.any(String));
		await fixture.reopenAbandoned();
		await fixture.session.bindExtensions({ mode: "rpc" });
		expect(fixture.session.lifecycle.activity).toBeUndefined();
		expect(fixture.session.lifecycle.activityRevision?.instanceId).not.toBe(oldOwner);
	} finally {
		stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Finished.") });
		stream.end();
		await run;
	}
});
