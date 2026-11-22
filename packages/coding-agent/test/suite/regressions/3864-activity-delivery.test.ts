import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import { observeLifecycleDelivery } from "../../../src/modes/rpc/lifecycle-delivery.ts";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { subscribeSessionRecords } from "../../../src/modes/rpc/session-record-stream.ts";
import { controlData } from "../../helpers/session-control-client.ts";
import { startEndpoint } from "../../helpers/session-control-fixture.ts";
import { nextSessionEvent, runToAgentIdle } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";
import { makeSink, MockAssistantStream } from "../rpc-connection-harness.ts";

it("preserves the owner activity key through live push, state and TUI-control delivery", async () => {
	const fixture = await createIdentityHarness();
	const stream = new MockAssistantStream();
	const requested = Promise.withResolvers<void>();
	let run: Promise<unknown> | undefined;
	let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
	const records: object[] = [];
	let stop = () => {};
	try {
		await fixture.session.bindExtensions({ mode: "rpc" });
		endpoint = await startEndpoint({ harness: fixture.harness });
		const client = fixture.bind();
		stop = subscribeSessionRecords(fixture.session, (record) => records.push(record));
		fixture.harness.agent.streamFunction = () => {
			requested.resolve();
			return stream;
		};
		run = runToAgentIdle(fixture, () => fixture.session.prompt("Stream"));
		await requested.promise;
		const initial = fixture.session.lifecycle;
		expect(initial.activityRevision).toMatchObject({ instanceId: expect.any(String), revision: 0 });
		expect(initial.activity).toBeUndefined();
		const message = fauxAssistantMessage("Live");
		const started = nextSessionEvent(
			fixture,
			(event) => event.type === "message_start" && event.message.role === "assistant",
		);
		stream.push({ type: "start", partial: message });
		await started;
		const active = structuredClone(fixture.session.lifecycle);
		expect(active.activity).toMatchObject({ kind: "model" });
		expect(active.seq).toBe(initial.seq);
		expect(active.activityRevision).toEqual({ instanceId: initial.activityRevision?.instanceId, revision: 1 });
		expect(client.messages()).toContainEqual(
			expect.objectContaining({
				type: "session_lifecycle",
				lifecycle: { ...active, observedAt: expect.any(String) },
			}),
		);
		expect(records).toContainEqual({
			type: "session_lifecycle",
			lifecycle: { ...active, observedAt: expect.any(String) },
		});
		expect(await client.send({ type: "get_state" })).toMatchObject({
			data: { lifecycle: { ...active, observedAt: expect.any(String) } },
		});
		expect(await controlData(endpoint.socket, { type: "get_state" })).toMatchObject({
			lifecycle: { ...active, observedAt: expect.any(String) },
		});
		expect(fixture.session.lifecycle).toEqual(active);
	} finally {
		stop();
		stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Done") });
		stream.end();
		await run;
		await endpoint?.endpoint.dispose();
		await fixture.cleanup();
	}
});

it.each([false, true])(
	"re-stamps present=%s activity across worker forwarding, open and attach without minting keys",
	async (present) => {
		const fixture = await createIdentityHarness();
		const fanout = new SessionEventFanout();
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-25T01:00:00.000Z"));
		try {
			const lifecycle: SessionLifecycle = Object.freeze({
				...fixture.session.lifecycle,
				state: "running",
				seq: 42,
				epoch: 3,
				activityRevision: Object.freeze({ instanceId: "engine-owner", revision: present ? 4 : 5 }),
				...(present
					? { activity: Object.freeze({ kind: "model" as const, since: "2026-10-25T00:00:00.000Z" }) }
					: {}),
			});
			const original = structuredClone(lifecycle);
			const lines: string[] = [];
			const writer = new SessionEventWriter(
				(line) => lines.push(line),
				() => {},
			);
			const records = [
				{ type: "session_lifecycle", lifecycle },
				{ type: "response", command: "get_state", success: true, data: { lifecycle } },
				{ type: "response", command: "open_session", success: true, data: { state: { lifecycle } } },
			];
			for (const record of records) expect(writer.enqueue("worker", record)).toBe(true);
			await writer.flush();
			for (const [index, line] of lines.entries()) {
				expect(JSON.parse(line)).toEqual({ ...observeLifecycleDelivery(records[index]), sessionId: "worker" });
			}
			const event = { type: "session_lifecycle", sessionId: "worker", lifecycle };
			const cached = `${JSON.stringify(event)}\n`;
			fanout.rememberSnapshot("worker", event, cached);
			for (const [index, id] of ["first", "reconnect"].entries()) {
				clock.mockReturnValue(Date.parse("2026-10-25T01:00:00.000Z") + (index + 1) * 1000);
				const sink = makeSink();
				fanout.registerConnection(id, sink.sink);
				try {
					const received = sink.waitFor((record) => record.type === "session_lifecycle", 10_000);
					fanout.attachConnectionToSession(id, "worker");
					expect(await received).toEqual({
						...event,
						lifecycle: { ...lifecycle, observedAt: new Date(Date.now()).toISOString() },
					});
				} finally {
					fanout.unregisterConnection(id);
				}
			}
			expect(lifecycle).toEqual(original);
			expect(fanout.replay["lifecycleSnapshots"].get("worker")?.line).toBe(cached);
			const { activityRevision: _activityRevision, ...legacy } = lifecycle;
			expect(observeLifecycleDelivery({ type: "session_lifecycle", lifecycle: legacy })).toEqual({
				type: "session_lifecycle",
				lifecycle: { ...legacy, observedAt: new Date(Date.now()).toISOString() },
			});
		} finally {
			clock.mockRestore();
			await fixture.cleanup();
		}
	},
);
