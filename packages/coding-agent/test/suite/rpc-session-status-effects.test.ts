import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { dataOf, type RawClient, statusHost, type WireRecord } from "./rpc-session-status-support.ts";

const hosts: Array<AsyncDisposable> = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host[Symbol.asyncDispose]();
});

async function host() {
	const created = await statusHost();
	hosts.push(created);
	return created;
}

type HeldOptions = { signal?: AbortSignal } | undefined;

/** Every turn is held until it is aborted, so the test decides when each turn ends. */
function holdTurns(rig: Awaited<ReturnType<typeof statusHost>>): void {
	rig.faux.setResponses(
		Array.from(
			{ length: 16 },
			() =>
				(_context: unknown, options: HeldOptions): Promise<AssistantMessage> =>
					new Promise((resolve) => {
						const settle = () => resolve(fauxAssistantMessage("held turn ended"));
						if (options?.signal?.aborted) settle();
						else options?.signal?.addEventListener("abort", settle, { once: true });
					}),
		),
	);
}

async function subscribe(client: RawClient, fields: Record<string, unknown> = {}) {
	const data = dataOf(await client.request({ type: "subscribe_sessions", ...fields }));
	return {
		subscriptionId: String(data.subscriptionId),
		snapshot: data.snapshot as WireRecord[],
		seq: Number(data.seq),
	};
}

function nextStatus(client: RawClient, subscriptionId: string, cause: string, sessionId?: string) {
	return client.waitFor(
		(record) =>
			record.type === "session_status" &&
			record.subscriptionId === subscriptionId &&
			(record.lastChange as { cause?: string } | undefined)?.cause === cause &&
			(sessionId === undefined || record.sessionId === sessionId),
	);
}

function nextEffect(client: RawClient, subscriptionId: string, state: string, sessionId?: string) {
	return client.waitFor(
		(record) =>
			record.type === "effect_status" &&
			record.subscriptionId === subscriptionId &&
			record.state === state &&
			(sessionId === undefined || record.sessionId === sessionId),
	);
}

function effectRecords(client: RawClient, subscriptionId: string): WireRecord[] {
	return client.inbox.filter((record) => record.type === "effect_status" && record.subscriptionId === subscriptionId);
}

/** Every record of one subscription (both types), in inbox order, with gap-free seq from the snapshot. */
function expectGapFreeSeq(client: RawClient, subscriptionId: string, snapshotSeq: number): void {
	const stream = client.inbox.filter(
		(record) =>
			(record.type === "session_status" || record.type === "effect_status") &&
			record.subscriptionId === subscriptionId,
	);
	expect(stream.map((record) => record.seq)).toEqual(stream.map((_, index) => snapshotSeq + index + 1));
}

describe("effect_status stream", () => {
	it("delivers accepted -> applied -> done for an abort with effectId, in order after the causing record", async () => {
		const rig = await host();
		holdTurns(rig);
		const a = rig.client("A");
		const b = rig.client("B");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const sub = await subscribe(b, { effects: true });
		expect(sub.snapshot).toHaveLength(1);
		expect(sub.snapshot[0]).not.toHaveProperty("lastEffect");

		const started = a.waitFor((record) => record.type === "agent_start" && record.sessionId === s1);
		await a.request({ type: "prompt", sessionId: s1, message: "run" });
		await started;
		const running = await nextStatus(b, sub.subscriptionId, "prompt", s1);

		const answer = dataOf(await a.request({ type: "abort", sessionId: s1, effectId: "e1" }));
		expect(answer.state).toBe("applied");

		const accepted = await nextEffect(b, sub.subscriptionId, "accepted", s1);
		const applied = await nextEffect(b, sub.subscriptionId, "applied", s1);
		const idle = await nextStatus(b, sub.subscriptionId, "agent_idle", s1);
		const done = await nextEffect(b, sub.subscriptionId, "done", s1);

		expect(accepted).toMatchObject({
			type: "effect_status",
			subscriptionId: sub.subscriptionId,
			sessionId: s1,
			effectId: "e1",
			kind: "abort",
			state: "accepted",
			by: { connectionId: expect.any(String) },
			at: expect.any(String),
		});
		expect(applied).toMatchObject({ effectId: "e1", kind: "abort", state: "applied" });
		expect(done).toMatchObject({ effectId: "e1", kind: "abort", state: "done" });

		// In order, after the abort was commanded; done lands after the agent_idle record that caused it.
		expect(b.inbox.indexOf(accepted)).toBeGreaterThan(b.inbox.indexOf(running));
		expect(b.inbox.indexOf(accepted)).toBeLessThan(b.inbox.indexOf(applied));
		expect(b.inbox.indexOf(applied)).toBeLessThan(b.inbox.indexOf(done));
		expect(b.inbox.indexOf(done)).toBeGreaterThan(b.inbox.indexOf(idle));
		expectGapFreeSeq(b, sub.subscriptionId, sub.seq);
	});

	it("defaults effects on for childrenOf and off otherwise, and honours the explicit flag", async () => {
		const rig = await host();
		holdTurns(rig);
		const a = rig.client("A");
		const b = rig.client("B");
		const subAll = await subscribe(b);
		const parent = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const parentOpen = await nextStatus(b, subAll.subscriptionId, "open", String(parent.sessionId));
		const durable = String(parentOpen.durableSessionId);
		const child = dataOf(
			await a.request({ type: "open_session", cwd: rig.cwd, context: { parent_session_id: durable } }),
		);
		const sChild = String(child.sessionId);
		const subKids = await subscribe(b, { sessions: { childrenOf: durable } });
		const subKidsOff = await subscribe(b, { sessions: { childrenOf: durable }, effects: false });

		const started = a.waitFor((record) => record.type === "agent_start" && record.sessionId === sChild);
		await a.request({ type: "prompt", sessionId: sChild, message: "run" });
		await started;
		await a.request({ type: "abort", sessionId: sChild, effectId: "eb" });

		const got = await nextEffect(b, subKids.subscriptionId, "applied", sChild);
		expect(got).toMatchObject({ effectId: "eb", kind: "abort", state: "applied" });
		// Same connection FIFO: `got` proves every record those subscriptions would have received is already here.
		expect(effectRecords(b, subAll.subscriptionId)).toEqual([]);
		expect(effectRecords(b, subKidsOff.subscriptionId)).toEqual([]);
	});

	it("emits input admission transitions queued -> running -> done as effect_status", async () => {
		const rig = await host();
		let releaseFirstTurn!: () => void;
		rig.faux.setResponses([
			() =>
				new Promise((resolve) => {
					releaseFirstTurn = () => resolve(fauxAssistantMessage("turn one done"));
				}),
			...Array.from(
				{ length: 8 },
				() =>
					(_context: unknown, options: HeldOptions): Promise<AssistantMessage> =>
						new Promise((resolve) => {
							const settle = () => resolve(fauxAssistantMessage("held turn ended"));
							if (options?.signal?.aborted) settle();
							else options?.signal?.addEventListener("abort", settle, { once: true });
						}),
			),
		]);
		const a = rig.client("A");
		const b = rig.client("B");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const sub = await subscribe(b, { effects: true });

		const started = a.waitFor((record) => record.type === "agent_start" && record.sessionId === s1);
		await a.request({ type: "prompt", sessionId: s1, message: "turn one" });
		await started;
		await a.request({ type: "follow_up", sessionId: s1, message: "turn two", clientMessageId: "i1" });

		const queued = await nextStatus(b, sub.subscriptionId, "queue", s1);
		const accepted = await nextEffect(b, sub.subscriptionId, "accepted", s1);
		expect(accepted).toMatchObject({ effectId: "i1", kind: "input", state: "accepted", disposition: "queued" });
		expect(b.inbox.indexOf(accepted)).toBeGreaterThan(b.inbox.indexOf(queued));

		releaseFirstTurn();
		const applied = await nextEffect(b, sub.subscriptionId, "applied", s1);
		expect(applied).toMatchObject({ effectId: "i1", kind: "input", state: "applied" });

		await a.request({ type: "abort", sessionId: s1 });
		const done = await nextEffect(b, sub.subscriptionId, "done", s1);
		expect(done).toMatchObject({ effectId: "i1", kind: "input", state: "done" });
		expect((done.outcome as { kind?: string } | undefined)?.kind).toBe("aborted");

		const idles = b.inbox.filter(
			(record) =>
				record.type === "session_status" &&
				record.subscriptionId === sub.subscriptionId &&
				(record.lastChange as { cause?: string } | undefined)?.cause === "agent_idle",
		);
		const lastIdle = idles.at(-1);
		if (lastIdle === undefined) throw new Error("no agent_idle status seen");
		expect(b.inbox.indexOf(done)).toBeGreaterThan(b.inbox.indexOf(lastIdle));
		expect(b.inbox.indexOf(accepted)).toBeLessThan(b.inbox.indexOf(applied));
		expect(b.inbox.indexOf(applied)).toBeLessThan(b.inbox.indexOf(done));
		expectGapFreeSeq(b, sub.subscriptionId, sub.seq);
	});

	it("fills session_status.lastEffect from the ledger on deltas and on a fresh snapshot", async () => {
		const rig = await host();
		holdTurns(rig);
		const a = rig.client("A");
		const b = rig.client("B");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const sub = await subscribe(b);
		expect(sub.snapshot[0]).not.toHaveProperty("lastEffect");

		const started = a.waitFor((record) => record.type === "agent_start" && record.sessionId === s1);
		await a.request({ type: "prompt", sessionId: s1, message: "run" });
		await started;
		await a.request({ type: "abort", sessionId: s1, effectId: "e1" });
		await nextStatus(b, sub.subscriptionId, "agent_idle", s1);

		// The ledger's agent_idle handler runs inside the same synchronous dispatch as the record, so by the
		// time that status reached this inbox the abort is `done`; the next delta must name it.
		dataOf(await a.request({ type: "set_model", sessionId: s1, provider: rig.model.provider, modelId: "faux-b" }));
		const after = await nextStatus(b, sub.subscriptionId, "set_model", s1);
		expect(after.lastEffect).toEqual({ effectId: "e1", kind: "abort", state: "done" });

		const fresh = await subscribe(b);
		const row = fresh.snapshot.find((record) => record.sessionId === s1);
		expect(row?.lastEffect).toEqual({ effectId: "e1", kind: "abort", state: "done" });
	});

	it("never delivers effect_status to a subscriber whose filter does not match the session", async () => {
		const rig = await host();
		holdTurns(rig);
		const a = rig.client("A");
		const b = rig.client("B");
		const s2 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const sub = await subscribe(b, { sessions: { ids: [s2] }, effects: true });
		expect(sub.snapshot.map((record) => record.sessionId)).toEqual([s2]);

		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const started = a.waitFor((record) => record.type === "agent_start" && record.sessionId === s1);
		await a.request({ type: "prompt", sessionId: s1, message: "run" });
		await started;
		await a.request({ type: "abort", sessionId: s1, effectId: "ex" });

		// A full request round-trip on B's own FIFO lands behind anything the effect flush enqueued for B.
		await b.request({ type: "list_sessions" });
		expect(effectRecords(b, sub.subscriptionId)).toEqual([]);
	});
});
