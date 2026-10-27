import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { subscribeSessionRecords } from "../../../src/modes/rpc/session-record-stream.ts";
import { controlData } from "../../helpers/session-control-client.ts";
import { startEndpoint } from "../../helpers/session-control-fixture.ts";
import { nextSessionEvent } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";
import { makeSink } from "../rpc-connection-harness.ts";
import { contextHost } from "../rpc-session-context-support.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

const FIRST = Date.parse("2026-10-24T01:00:00.000Z");
const SECOND = FIRST + 1_000;
const lifecycleSchema = z.looseObject({ observedAt: z.string() });
const stateSchema = z.object({ lifecycle: lifecycleSchema });

afterEach(() => vi.restoreAllMocks());

// senpi#3864: delivery time must not become engine state or durable ordering.
it("stamps get_state and connection/classic-stdio pushes without changing the snapshot or durable record", async () => {
	const fixture = await createIdentityHarness();
	try {
		await fixture.session.bindExtensions({ mode: "rpc" });
		const client = fixture.bind();
		const records: object[] = [];
		const stop = subscribeSessionRecords(fixture.session, (record) => records.push(record));
		const clock = vi.spyOn(Date, "now").mockReturnValue(FIRST);
		const waiting = nextSessionEvent(
			fixture,
			(event) => event.type === "session_lifecycle" && event.lifecycle.state === "waiting_background",
		);
		const hold = fixture.session.workObligations.open("freshness", "background");
		await waiting;
		stop();
		const snapshot = structuredClone(fixture.session.lifecycle);
		const pushed = client.messages().findLast((record) => record.type === "session_lifecycle");
		expect(pushed).toMatchObject({ lifecycle: { ...snapshot, observedAt: new Date(FIRST).toISOString() } });
		expect(records).toContainEqual({
			type: "session_lifecycle",
			lifecycle: { ...snapshot, observedAt: new Date(FIRST).toISOString() },
		});
		clock.mockReturnValue(SECOND);
		const state = await client.send({ type: "get_state" });
		expect(state).toMatchObject({
			data: { lifecycle: { ...snapshot, observedAt: new Date(SECOND).toISOString() } },
		});
		expect(fixture.session.lifecycle).toEqual(snapshot);
		expect(snapshot).not.toHaveProperty("observedAt");
		const durable = fixture.harness.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "custom" && entry.customType === "session-lifecycle");
		expect(durable).toMatchObject({ data: { seq: snapshot.seq, epoch: snapshot.epoch } });
		expect(durable && "data" in durable ? durable.data : undefined).not.toHaveProperty("observedAt");
		hold.close("consumed");
	} finally {
		await fixture.cleanup();
	}
});

it("re-stamps each attach from the cached line without mutating its content or completion identity", async () => {
	const fixture = await createIdentityHarness();
	const fanout = new SessionEventFanout();
	try {
		const lifecycle = {
			...fixture.session.lifecycle,
			state: "done",
			completionId: "root:1",
			completion: { kind: "reply", at: new Date(FIRST).toISOString() },
			settleDecision: { decisionId: "settle-1" },
		};
		const event = { type: "session_lifecycle", sessionId: "root", lifecycle };
		const line = `${JSON.stringify(event)}\n`;
		fanout.rememberSnapshot("root", event, line);
		const clock = vi.spyOn(Date, "now").mockReturnValue(FIRST);
		const deliveries: Record<string, unknown>[] = [];
		for (const [id, now] of [
			["first", FIRST],
			["second", SECOND],
		] as const) {
			clock.mockReturnValue(now);
			const sink = makeSink();
			fanout.registerConnection(id, sink.sink);
			const received = sink.waitFor((record) => record.type === "session_lifecycle", 10_000);
			fanout.attachConnectionToSession(id, "root");
			deliveries.push(await received);
			fanout.unregisterConnection(id);
		}
		expect(deliveries[0]).toEqual({
			...event,
			lifecycle: { ...lifecycle, observedAt: new Date(FIRST).toISOString() },
		});
		expect(deliveries[1]).toEqual({
			...event,
			lifecycle: { ...lifecycle, observedAt: new Date(SECOND).toISOString() },
		});
		expect(fanout["lifecycleSnapshots"].get("root")?.line).toBe(line);
		expect(event.lifecycle).not.toHaveProperty("observedAt");
	} finally {
		await fixture.cleanup();
	}
});

it("stamps cached worker lifecycle and state replies at host enqueue rather than retaining worker delivery time", async () => {
	const fixture = await createIdentityHarness();
	try {
		const lifecycle = { ...fixture.session.lifecycle, observedAt: "2020-01-01T00:00:00.000Z" };
		const lines: string[] = [];
		const writer = new SessionEventWriter(
			(line) => lines.push(line),
			() => {},
		);
		vi.spyOn(Date, "now").mockReturnValue(SECOND);
		for (const record of [
			{ type: "session_lifecycle", lifecycle },
			{ type: "response", command: "get_state", success: true, data: { lifecycle } },
			{ type: "response", command: "open_session", success: true, data: { state: { lifecycle } } },
		])
			expect(writer.enqueue("worker", record)).toBe(true);
		await writer.flush();
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{
				type: "session_lifecycle",
				sessionId: "worker",
				lifecycle: { ...lifecycle, observedAt: new Date(SECOND).toISOString() },
			},
			{
				type: "response",
				command: "get_state",
				success: true,
				sessionId: "worker",
				data: { lifecycle: { ...lifecycle, observedAt: new Date(SECOND).toISOString() } },
			},
			{
				type: "response",
				command: "open_session",
				success: true,
				sessionId: "worker",
				data: { state: { lifecycle: { ...lifecycle, observedAt: new Date(SECOND).toISOString() } } },
			},
		]);
		expect(lifecycle.observedAt).toBe("2020-01-01T00:00:00.000Z");
	} finally {
		await fixture.cleanup();
	}
});

it("stamps open_session and a later attach without advancing lifecycle seq", async () => {
	await using host = await contextHost();
	const clock = vi.spyOn(Date, "now").mockReturnValue(FIRST);
	const sessionPath = join(host.scratch, "freshness.jsonl");
	const opened = await host.open("first", { sessionPath });
	const first = stateSchema.parse(opened.state).lifecycle;
	expect(first.observedAt).toBe(new Date(FIRST).toISOString());
	expect(first.activityRevision).toMatchObject({ instanceId: expect.any(String), revision: 0 });
	clock.mockReturnValue(SECOND);
	const attached = await host.open("second", { sessionPath });
	const second = stateSchema.parse(attached.state).lifecycle;
	expect(second).toEqual({ ...first, observedAt: new Date(SECOND).toISOString() });
}, 60_000);

it("stamps TUI-control state on each receipt without mutating the engine snapshot", async () => {
	const fixture = await startEndpoint();
	try {
		const snapshot = structuredClone(fixture.harness.session.lifecycle);
		const clock = vi.spyOn(Date, "now").mockReturnValue(FIRST);
		const first = stateSchema.parse(await controlData(fixture.socket, { type: "get_state" })).lifecycle;
		expect(first).toEqual({ ...snapshot, observedAt: new Date(FIRST).toISOString() });
		clock.mockReturnValue(SECOND);
		const second = stateSchema.parse(await controlData(fixture.socket, { type: "get_state" })).lifecycle;
		expect(second).toEqual({ ...snapshot, observedAt: new Date(SECOND).toISOString() });
		expect(fixture.harness.session.lifecycle).toEqual(snapshot);
	} finally {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

it("delivers fresh worker open and get_state responses through the real stdio transport", async () => {
	const host = await startWorkerHost(undefined, {
		preload: `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const clock = join(process.env.TMPDIR, "delivery-clock");
Date.now = () => existsSync(clock) ? Number(readFileSync(clock, "utf8")) : ${FIRST};`,
	});
	try {
		const opened = await host.request({ type: "open_session", cwd: host.cwd });
		expect(opened.success).toBe(true);
		const first = stateSchema.parse(opened.data?.state).lifecycle;
		expect(first.observedAt).toBe(new Date(FIRST).toISOString());
		expect(first.activityRevision).toMatchObject({ instanceId: expect.any(String), revision: 0 });
		const sessionId = String(opened.data?.sessionId);
		await writeFile(join(host.scratch, "delivery-clock"), String(SECOND));
		const state = await host.request({ type: "get_state", sessionId });
		expect(state.success).toBe(true);
		expect(stateSchema.parse(state.data).lifecycle).toEqual({
			...first,
			observedAt: new Date(SECOND).toISOString(),
		});
	} finally {
		await host.dispose();
	}
}, 90_000);
