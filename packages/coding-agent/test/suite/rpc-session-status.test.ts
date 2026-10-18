import { afterEach, describe, expect, it, vi } from "vitest";
import { dataOf, type RawClient, statusHost, statusRecords, type WireRecord } from "./rpc-session-status-support.ts";

const hosts: Array<AsyncDisposable> = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host[Symbol.asyncDispose]();
});

async function host() {
	const created = await statusHost();
	hosts.push(created);
	return created;
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

describe("session_status stream (T1 acceptance)", () => {
	it("delivers open, set_model, queue, abort, replace, a second open and a detach to an unattached subscriber in order", async () => {
		const rig = await host();
		const a = rig.client("A");
		const b = rig.client("B");
		const c = rig.client("C");

		// Given: B is subscribed to every session and never attaches to any.
		const sub = await subscribe(b);
		expect(sub.snapshot).toEqual([]);
		expect(sub.seq).toBe(0);

		// When: A opens rpc-1, C and A2 attach to it, then A drives it.
		const opened = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s1 = String(opened.sessionId);
		const firstPath = String((opened.state as { sessionFile?: string }).sessionFile);
		await nextStatus(b, sub.subscriptionId, "open", s1);
		dataOf(await c.request({ type: "open_session", cwd: rig.cwd, sessionPath: firstPath }));
		await nextStatus(b, sub.subscriptionId, "attach", s1);
		const third = rig.client("A2");
		dataOf(await third.request({ type: "open_session", cwd: rig.cwd, sessionPath: firstPath }));
		const attached3 = await b.waitFor(
			(record) =>
				record.type === "session_status" &&
				record.subscriptionId === sub.subscriptionId &&
				record.attachments === 3,
		);
		expect(attached3.lastChange).toMatchObject({ cause: "attach" });

		dataOf(await a.request({ type: "set_model", sessionId: s1, provider: rig.model.provider, modelId: "faux-b" }));
		const modelStatus = await nextStatus(b, sub.subscriptionId, "set_model", s1);
		expect(modelStatus.model).toEqual({ provider: rig.model.provider, id: "faux-b" });

		dataOf(await a.request({ type: "steer", sessionId: s1, message: "queued steer" }));
		const queued = await nextStatus(b, sub.subscriptionId, "queue", s1);
		expect(queued.pendingQueue).toMatchObject({ steering: 1 });

		dataOf(await a.request({ type: "abort", sessionId: s1 }));
		const aborted = await nextStatus(b, sub.subscriptionId, "abort", s1);
		expect(aborted).toMatchObject({ status: "idle", reason: "aborted" });

		const durableBefore = attached3.durableSessionId;
		dataOf(await a.request({ type: "new_session", sessionId: s1 }));
		const replaced = await nextStatus(b, sub.subscriptionId, "replace", s1);
		expect(replaced.sessionId).toBe(s1);
		expect(replaced.durableSessionId).not.toBe(durableBefore);

		const second = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s2 = String(second.sessionId);
		const openedRecord = await b.waitFor((record) => record.type === "session_opened" && record.sessionId === s2);
		expect(openedRecord).toMatchObject({ kind: "interactive", cwd: rig.cwd });
		await nextStatus(b, sub.subscriptionId, "open", s2);

		dataOf(await a.request({ type: "close_session", sessionId: s1 }));
		const detached = await nextStatus(b, sub.subscriptionId, "detach", s1);
		expect(detached.attachments).toBe(2);

		// Then: B saw every change in that order, never attached, with seq strictly +1 from the snapshot.
		const records = statusRecords(b, sub.subscriptionId);
		expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => sub.seq + index + 1));
		const causes = records.map((record) => `${(record.lastChange as { cause: string }).cause}@${record.sessionId}`);
		const order = [
			`open@${s1}`,
			`set_model@${s1}`,
			`queue@${s1}`,
			`abort@${s1}`,
			`replace@${s1}`,
			`open@${s2}`,
			`detach@${s1}`,
		];
		let cursor = -1;
		for (const expected of order) {
			const index = causes.indexOf(expected, cursor + 1);
			expect(index, `${expected} after ${causes.slice(0, cursor + 1).join(",")}`).toBeGreaterThan(cursor);
			cursor = index;
		}
		const listed = dataOf(await b.request({ type: "list_sessions" })).sessions as Array<{
			sessionId: string;
			attachments: number;
		}>;
		expect(listed.find((row) => row.sessionId === s1)?.attachments).toBe(2);
	});

	it("answers subscribe_sessions BEFORE any seq 1 record, even when a change is published mid-dispatch (#3198 review)", async () => {
		const rig = await host();
		const a = rig.client("A");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);

		// Given: the subscription is registered by one dispatch, then a change is published by the NEXT
		// dispatch before the first one's response had any async hop to overtake. The two-command
		// ladder reproduces the review's window without any clock: the publish provably runs between
		// registration and the response's enqueue.
		const sub = await subscribe(a, { include_context: true });
		expect((sub.snapshot as Array<{ sessionId: string }>).map((record) => record.sessionId)).toEqual([s1]);
		rig.writer.status.publish(s1, "context", "client", true);
		dataOf(await a.request({ type: "list_sessions" }));

		// The stream-level contract the whole mechanism exists for: a change published while the
		// subscription is pending its response is HELD, then delivered as seq 1 behind it.
		const record = await nextStatus(a, sub.subscriptionId, "context", s1);
		expect(record).toMatchObject({ seq: sub.seq + 1, sessionId: s1 });
		const responseIndex = a.inbox.findIndex(
			(candidate) =>
				candidate.type === "response" && candidate.command === "subscribe_sessions" && candidate.success === true,
		);
		expect(responseIndex).toBeGreaterThanOrEqual(0);
		expect(
			a.inbox.indexOf(record),
			"the seq 1 delta must arrive after the response carrying the seq 0 snapshot",
		).toBeGreaterThan(responseIndex);
	});

	it("holds a change published before activation as seq 1 on the pending subscription (#3198 review)", async () => {
		const { SessionStatusStream } = await import("../../src/modes/rpc/session-status-stream.ts");
		const enqueued: string[] = [];
		const stream = new SessionStatusStream({
			enqueue: (_connectionId, line) => {
				enqueued.push(line);
				return true;
			},
			pendingQuestions: () => 0,
		});
		stream.setSource({
			sessionIds: () => ["rpc-1"],
			entryView: () => ({ state: "open", kind: "interactive", cwd: "/w", attachments: 1, context: {} }),
			view: () => ({ entry: { state: "open", kind: "interactive", cwd: "/w", attachments: 1, context: {} } }),
		});
		const pending = stream.subscribe("c", {
			selector: { kind: "all" },
			includeWorkers: false,
			includeContext: true,
			mirror: { kind: "none" },
			effects: false,
		});
		// A publish lands while the subscription is registered but its response is not yet on the wire.
		stream.publish("rpc-1", "context", "client", true);
		// Pre-fix: nothing was held, so activation delivered zero records. Post-fix: one held seq-1 record.
		expect(enqueued).toHaveLength(0);
		stream.activate(pending.subscriptionId);
		expect(enqueued).toHaveLength(1);
		const delivered = JSON.parse(enqueued[0]!.trim()) as {
			seq: number;
			subscriptionId: string;
			lastChange: { cause: string };
		};
		expect(delivered).toMatchObject({ seq: pending.seq + 1, subscriptionId: pending.subscriptionId });
		expect(delivered.lastChange.cause).toBe("context");
	});

	it("emits the status AFTER the record that caused it on a connection that is also attached", async () => {
		const rig = await host();
		const a = rig.client("A");
		const opened = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s1 = String(opened.sessionId);
		const sub = await subscribe(a);
		dataOf(await a.request({ type: "steer", sessionId: s1, message: "queued" }));
		const status = await nextStatus(a, sub.subscriptionId, "queue", s1);
		const queueIndex = a.inbox.findIndex((record) => record.type === "queue_update" && record.sessionId === s1);
		expect(queueIndex).toBeGreaterThanOrEqual(0);
		expect(a.inbox.indexOf(status)).toBeGreaterThan(queueIndex);
	});

	it("matches a worker opened later under childrenOf by context.parent_session_id", async () => {
		const rig = await host();
		const parent = rig.client("parent");
		const watcher = rig.client("watcher");
		const sub = await subscribe(watcher, { sessions: { childrenOf: "parent-durable" } });
		const other = dataOf(await parent.request({ type: "open_session", cwd: rig.cwd, kind: "worker" }));
		const child = dataOf(
			await parent.request({
				type: "open_session",
				cwd: rig.cwd,
				kind: "worker",
				context: { parent_session_id: "parent-durable", task_id: "t1" },
			}),
		);
		const opened = await watcher.waitFor(
			(record) => record.type === "session_opened" && record.sessionId === child.sessionId,
		);
		expect(opened.kind).toBe("worker");
		await nextStatus(watcher, sub.subscriptionId, "open", String(child.sessionId));
		expect(watcher.inbox.some((record) => record.sessionId === other.sessionId)).toBe(false);

		dataOf(await parent.request({ type: "close_session", sessionId: child.sessionId }));
		const ended = await nextStatus(watcher, sub.subscriptionId, "close", String(child.sessionId));
		expect(ended).toMatchObject({ status: "closed", reason: "client_close", kind: "worker" });
		expect(watcher.inbox.some((record) => record.type === "session_closed")).toBe(false);
	});
});

describe("activity neutrality and mirror opt-in", () => {
	it("a subscriber-only connection never counts as an attachment nor refreshes the idle window", async () => {
		const rig = await host();
		const a = rig.client("A");
		const b = rig.client("B");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const row = async () =>
			(
				dataOf(await b.request({ type: "list_sessions" })).sessions as Array<{
					sessionId: string;
					attachments: number;
					idleMs: number;
				}>
			).find((listed) => listed.sessionId === s1);
		const before = await row();
		rig.clock.now += 5_000;
		await subscribe(b, { mirror: "all" });
		await b.request({ type: "unsubscribe_sessions", subscriptionId: "sub-missing" });
		rig.clock.now += 5_000;
		const after = await row();
		expect(after?.attachments).toBe(before?.attachments);
		expect(after?.idleMs).toBe((before?.idleMs ?? 0) + 10_000);
	});

	it("mirrors only the opted-in content kinds, never to a subscriber without mirror, worker content only with include_workers", async () => {
		const rig = await host();
		const a = rig.client("A");
		const mirror = rig.client("mirror");
		const statusOnly = rig.client("statusOnly");
		const interactiveOnly = rig.client("interactiveOnly");
		const sub = await subscribe(mirror, {
			sessions: "all",
			include_workers: true,
			mirror: ["message_update", "tool_execution_start"],
		});
		await subscribe(statusOnly);
		await subscribe(interactiveOnly, { mirror: "all", include_workers: false });

		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const worker = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd, kind: "worker" })).sessionId);
		rig.faux.setResponses([
			{
				role: "assistant",
				content: [{ type: "text", text: "interactive reply" }],
				api: rig.faux.api,
				provider: rig.model.provider,
				model: rig.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "ls", arguments: { path: "." } }],
				api: rig.faux.api,
				provider: rig.model.provider,
				model: rig.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "worker done" }],
				api: rig.faux.api,
				provider: rig.model.provider,
				model: rig.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
		]);
		const idle1 = a.waitFor((record) => record.type === "agent_idle" && record.sessionId === s1);
		dataOf(await a.request({ type: "prompt", sessionId: s1, message: "hello" }));
		await idle1;
		const idle2 = a.waitFor((record) => record.type === "agent_idle" && record.sessionId === worker);
		dataOf(await a.request({ type: "prompt", sessionId: worker, message: "list" }));
		await idle2;
		await rig.writer.flush();

		expect(mirror.inbox.some((record) => record.type === "message_update" && record.sessionId === s1)).toBe(true);
		expect(mirror.inbox.some((record) => record.type === "tool_execution_start" && record.sessionId === worker)).toBe(
			true,
		);
		expect(mirror.inbox.some((record) => record.type === "message_start")).toBe(false);
		expect(
			statusOnly.inbox.some((record) => record.type === "message_update" || record.type === "tool_execution_start"),
		).toBe(false);
		expect(interactiveOnly.inbox.some((record) => record.type === "message_update" && record.sessionId === s1)).toBe(
			true,
		);
		expect(
			interactiveOnly.inbox.some(
				(record) =>
					record.sessionId === worker &&
					record.type !== "agent_start" &&
					record.type !== "agent_settled" &&
					record.type !== "agent_idle",
			),
		).toBe(false);
		const listed = dataOf(await mirror.request({ type: "list_sessions", include_workers: true })).sessions as Array<{
			sessionId: string;
			attachments: number;
		}>;
		expect(listed.find((row) => row.sessionId === s1)?.attachments).toBe(1);
		expect(statusRecords(mirror, sub.subscriptionId).length).toBeGreaterThan(0);
	});
});

describe("subscription cap and transport refusal codes (#3198 review, L4 + L2)", () => {
	it("refuses a 65th subscription on one connection with subscription_limit and reason/action", async () => {
		const rig = await host();
		const a = rig.client("A");
		for (let i = 0; i < 64; i++) {
			const answer = await a.request({ type: "subscribe_sessions" });
			expect(answer.success).toBe(true);
		}
		const refused = await a.request({ type: "subscribe_sessions" });
		expect(refused).toMatchObject({ success: false, errorCode: "subscription_limit" });
		expect(String(refused.error)).toContain("subscription_limit: this connection already holds 64 subscriptions");
		expect(refused.errorData).toEqual({
			reason: "this connection already holds 64 subscriptions",
			action: "unsubscribe_sessions the ones you no longer read, then subscribe again",
		});
		// Another connection is unaffected by A's cap.
		const b = rig.client("B");
		expect((await b.request({ type: "subscribe_sessions" })).success).toBe(true);
	});

	it("stdio transports refuse subscribe/unsubscribe with a code that names the transport", async () => {
		const { answerSubscribeSessions, answerUnsubscribeSessions } = await import(
			"../../src/modes/rpc/session-status-commands.ts"
		);
		const { SessionStatusStream } = await import("../../src/modes/rpc/session-status-stream.ts");
		const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0 });
		stream.setSource({ sessionIds: () => [], view: () => undefined, entryView: () => undefined });
		const failure = (
			response: unknown,
		): { success: false; error: string; errorCode?: string; errorData?: unknown } => {
			if (typeof response !== "object" || response === null || (response as { success?: unknown }).success !== false)
				throw new Error("expected a failure response");
			return response as { success: false; error: string; errorCode?: string; errorData?: unknown };
		};
		const subscribe = answerSubscribeSessions({ id: "s1", type: "subscribe_sessions" }, undefined, stream);
		const subscribeFailure = failure(subscribe.answer);
		expect(subscribeFailure.errorCode).toBe("unsupported_transport");
		expect(subscribeFailure.error).toContain("stdio");
		expect(subscribeFailure.errorData).toEqual({
			reason: "stdio has no per-connection identity to deliver a subscription to",
			action: "connect to the host socket (senpi --mode rpc --listen) and subscribe there",
		});
		expect(subscribe.activate).toBeUndefined();
		const unsubscribe = answerUnsubscribeSessions(
			{ id: "u1", type: "unsubscribe_sessions", subscriptionId: "sub-1" },
			undefined,
			stream,
		);
		const unsubscribeFailure = failure(unsubscribe);
		expect(unsubscribeFailure.errorCode).toBe("unsupported_transport");
		expect(unsubscribeFailure.errorData).toEqual({
			reason: "stdio has no per-connection identity holding any subscription",
			action: "connect to the host socket (senpi --mode rpc --listen) and manage subscriptions there",
		});
	});
});

describe("set_session_context and error copy", () => {
	it("patches context, republishes it to include_context subscribers and refuses reserved keys with reason and action", async () => {
		const rig = await host();
		const a = rig.client("A");
		const watcher = rig.client("watcher");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd, kind: "worker" })).sessionId);
		const sub = await subscribe(watcher, { include_workers: true, include_context: true });
		const patched = dataOf(
			await a.request({
				type: "set_session_context",
				sessionId: s1,
				patch: { task_status: "running", run_epoch: 2 },
			}),
		);
		expect(patched.context).toMatchObject({ task_status: "running", run_epoch: 2 });
		const status = await nextStatus(watcher, sub.subscriptionId, "context", s1);
		expect(status.context).toMatchObject({ task_status: "running" });

		const refused = await a.request({
			type: "set_session_context",
			sessionId: s1,
			patch: { host_socket: "/elsewhere" },
		});
		expect(refused).toMatchObject({ success: false, errorCode: "invalid_session_context" });
		expect(String(refused.error)).toBe(
			'invalid_session_context: key "host_socket" is set by the host and cannot be patched',
		);
		expect(refused.errorData).toEqual({
			reason: 'key "host_socket" is set by the host and cannot be patched',
			action: "drop that key from the patch; the host keeps it current",
		});

		const outsider = await watcher.request({ type: "set_session_context", sessionId: s1, patch: { a: "b" } });
		expect(outsider.errorData).toEqual({
			reason: "this connection is not attached to that session",
			action: "attach first with open_session { sessionPath }, then patch its context",
		});
		const badSub = await watcher.request({ type: "subscribe_sessions", sessions: { ids: [] } });
		expect(badSub).toMatchObject({ success: false, errorCode: "invalid_subscription" });
		expect((badSub.errorData as { action: string }).action).toContain("send sessions:");
		const unknown = await watcher.request({ type: "unsubscribe_sessions", subscriptionId: "nope" });
		expect(unknown.errorData).toEqual({
			reason: "this connection holds no subscription with that id",
			action: "send the subscriptionId your subscribe_sessions answer returned, on the same connection",
		});
		const rows = dataOf(await watcher.request({ type: "list_sessions", include_workers: true })).sessions as Array<{
			sessionId: string;
			context: Record<string, unknown>;
		}>;
		expect(rows.find((row) => row.sessionId === s1)?.context).toMatchObject({ task_status: "running", run_epoch: 2 });
	});
});

describe("lineage keys and childrenOf membership (#3198 review)", () => {
	it("refuses a parent_session_id patch, and childrenOf membership is unaffected by any patch", async () => {
		const rig = await host();
		const parent = rig.client("parent");
		const watcher = rig.client("watcher");
		// Given: a childrenOf subscription watching parent-durable, and a worker child opened under it.
		const sub = await subscribe(watcher, { sessions: { childrenOf: "parent-durable" }, include_workers: true });
		const child = dataOf(
			await parent.request({
				type: "open_session",
				cwd: rig.cwd,
				kind: "worker",
				context: { parent_session_id: "parent-durable", task_id: "t1" },
			}),
		);
		const childId = String(child.sessionId);
		await nextStatus(watcher, sub.subscriptionId, "open", childId);

		// When: the attached parent tries to re-parent the child through a context patch.
		const refused = await parent.request({
			type: "set_session_context",
			sessionId: childId,
			patch: { parent_session_id: "stranger" },
		});
		// Then: lineage keys are reserved, with the same reason/action errorData shape as host keys.
		expect(refused).toMatchObject({ success: false, errorCode: "invalid_session_context" });
		expect(String(refused.error)).toBe(
			'invalid_session_context: key "parent_session_id" is set by the host and cannot be patched',
		);
		expect(refused.errorData).toEqual({
			reason: 'key "parent_session_id" is set by the host and cannot be patched',
			action: "drop that key from the patch; the host keeps it current",
		});
		const refusedRoot = await parent.request({
			type: "set_session_context",
			sessionId: childId,
			patch: { root_session_id: null },
		});
		expect(refusedRoot).toMatchObject({ success: false, errorCode: "invalid_session_context" });

		// And: a patch to a non-lineage key leaves the child's childrenOf membership untouched.
		dataOf(await parent.request({ type: "set_session_context", sessionId: childId, patch: { note: "x" } }));
		dataOf(await parent.request({ type: "steer", sessionId: childId, message: "queued" }));
		const queued = await nextStatus(watcher, sub.subscriptionId, "queue", childId);
		expect(queued.sessionId).toBe(childId);

		// And: a unit-level proof that childrenOf matching reads the frozen open context, not the
		// published overlay - the spoof the reviewer named, at the boundary that decides membership.
		const { subscriptionMatches } = await import("../../src/modes/rpc/session-status-subscriptions.ts");
		const options = {
			selector: { kind: "childrenOf" as const, parent: "parent-durable" },
			includeWorkers: true,
			includeContext: false,
			mirror: { kind: "none" as const },
			effects: true,
		};
		const frozen = {
			kind: "worker" as const,
			context: { task_id: "t2" },
			openContext: { parent_session_id: "parent-durable" },
		};
		expect(subscriptionMatches(options, "rpc-x", frozen)).toBe(true);
		// If matching read the published (patchable) context, this session would not match - it must.
		const spoofedOut = {
			kind: "worker" as const,
			context: { parent_session_id: "stranger" },
			openContext: { parent_session_id: "parent-durable" },
		};
		expect(subscriptionMatches(options, "rpc-y", spoofedOut)).toBe(true);
		// A session that never had the lineage must not match even if a patch could add one.
		const notAChild = { kind: "worker" as const, context: { task_id: "t2" }, openContext: { task_id: "t2" } };
		expect(subscriptionMatches(options, "rpc-z", notAChild)).toBe(false);
	});
});

describe("an open rolled back after session_opened (#3198 review round 2, L1)", () => {
	it("seals the session for subscribers without sending the opener a close_session it never asked for", async () => {
		const rig = await host();
		const a = rig.client("A");
		const b = rig.client("B");
		const sub = await subscribe(b);
		// Given: the open publishes session_opened and its open status, then its own answer fails to queue.
		const enqueue = rig.writer.enqueue.bind(rig.writer);
		const spy = vi.spyOn(rig.writer, "enqueue").mockImplementation((sessionId, record) => {
			const response = record as { type?: string; command?: string };
			if (response.type === "response" && response.command === "open_session") throw new Error("answer refused");
			return enqueue(sessionId, record);
		});
		const before = a.inbox.length;
		// When: A opens a session and the open rolls back.
		const failed = await a.request({ type: "open_session", cwd: rig.cwd });
		spy.mockRestore();
		await rig.writer.flush();
		expect(failed.success).toBe(false);
		const opened = b.inbox.find((record) => record.type === "session_opened");
		expect(opened).toBeDefined();
		// Then: subscribers get the terminal record for the session they were told about...
		const terminal = statusRecords(b, sub.subscriptionId).find(
			(record) => record.sessionId === opened?.sessionId && record.status === "closed",
		);
		expect(terminal).toBeDefined();
		// ...and the opener sees only its own failed open, never an unrequested close_session answer.
		const closeAnswers = a.inbox
			.slice(before)
			.filter((record) => record.type === "response" && record.command === "close_session");
		expect(closeAnswers).toEqual([]);
	});
});

describe("subscribe racing its connection's close (#3198 review round 2, M1)", () => {
	it("leaves no pending subscription behind for a connection that closed before the subscribe was dispatched", async () => {
		const rig = await host();
		const a = rig.client("A");
		rig.client("Z");
		// Given: Z's transport closes while its subscribe_sessions is still on its way to dispatch.
		rig.writer.unregisterConnection("Z");
		// When: the subscribe is dispatched anyway, and a session then changes for an "all" selector.
		await rig.writer.withConnection("Z", () =>
			rig.core.handle(JSON.stringify({ type: "subscribe_sessions", id: "Z-late" })),
		);
		await rig.writer.flush();
		dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		await rig.writer.flush();
		// Then: nothing is kept for the dead connection, so nothing accumulates for the life of the host.
		expect(rig.writer.status.connectionSize("Z")).toBe(0);
	});
});

describe("F13: loaded_surfaces_changed dedupe", () => {
	it("tells a connection attached to several sessions about one inventory change once", async () => {
		const rig = await host();
		const a = rig.client("A");
		const s1 = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s2 = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const before = a.inbox.length;
		const snapshot = {
			servers: [
				{
					name: "probe",
					serverInfo: null,
					tools: [],
					resources: [],
					resourceTemplates: [],
					authStatus: "unsupported",
				},
			],
		};
		for (const durable of [s1, s2].map((opened) => String((opened.state as { sessionId: string }).sessionId))) {
			rig.extensionApis
				.get(durable)
				?.events.emit("senpi.rpc.mcp_inventory.changed", { sessionId: durable, snapshot });
		}
		await rig.writer.flush();
		const changes = a.inbox.slice(before).filter((record) => record.type === "loaded_surfaces_changed");
		expect(changes).toHaveLength(1);
	});

	it("still announces when a session converges onto a digest the connection heard from a different start (#3198 review)", async () => {
		const rig = await host();
		const a = rig.client("A");
		const s1 = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s3 = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const d1 = String((s1.state as { sessionId: string }).sessionId);
		const d3 = String((s3.state as { sessionId: string }).sessionId);
		const emit = (durable: string, server: string) =>
			rig.extensionApis.get(durable)?.events.emit("senpi.rpc.mcp_inventory.changed", {
				sessionId: durable,
				snapshot: {
					servers: [
						{
							name: server,
							serverInfo: null,
							tools: [],
							resources: [],
							resourceTemplates: [],
							authStatus: "unsupported",
						},
					],
				},
			});
		const before = a.inbox.length;
		// Given: S3 first surfaces a partial inventory Dpre (MCP still connecting), and the connection hears it.
		emit(d3, "probe-pre");
		await rig.writer.flush();
		// And: S1 then converges on the full inventory D, so the connection's last heard digest is D.
		emit(d1, "probe");
		await rig.writer.flush();
		// When: S3 converges on the same D from Dpre.
		emit(d3, "probe");
		await rig.writer.flush();
		// Then: the connection is told S3's own change - reads like get_commands are per session, so the
		// event naming S1 alone would leave S3's command list stale. Only truly shared transitions dedupe.
		const changes = a.inbox.slice(before).filter((record) => record.type === "loaded_surfaces_changed");
		expect(changes.map((record) => record.sessionId)).toEqual([s3.sessionId, s1.sessionId, s3.sessionId]);
	});

	it("announces a session's first change on a connection that attached after it moved (#3198 review round 2, H1)", async () => {
		const rig = await host();
		const a = rig.client("A");
		const b = rig.client("B");
		const emit = (durable: string, server: string) =>
			rig.extensionApis.get(durable)?.events.emit("senpi.rpc.mcp_inventory.changed", {
				sessionId: durable,
				snapshot: {
					servers: [
						{
							name: server,
							serverInfo: null,
							tools: [],
							resources: [],
							resourceTemplates: [],
							authStatus: "unsupported",
						},
					],
				},
			});
		// Given: B alone holds S3 while it moves to a partial inventory Dpre, so A never hears that move.
		const s3 = dataOf(await b.request({ type: "open_session", cwd: rig.cwd }));
		const d3 = String((s3.state as { sessionId: string }).sessionId);
		emit(d3, "probe-pre");
		await rig.writer.flush();
		// And: A opens S1 and only then attaches S3.
		const s1 = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const d1 = String((s1.state as { sessionId: string }).sessionId);
		const s3Path = String((s3.state as { sessionFile?: string }).sessionFile);
		const s3OnA = dataOf(await a.request({ type: "open_session", cwd: rig.cwd, sessionPath: s3Path }));
		const before = a.inbox.length;
		// When: S1 moves to the full inventory D, then S3 moves from Dpre to the same D.
		emit(d1, "probe");
		await rig.writer.flush();
		emit(d3, "probe");
		await rig.writer.flush();
		// Then: A hears both. They are different transitions (X->D and Dpre->D) even though this is each
		// session's first change on A, and get_commands for S3 would otherwise stay stale.
		const changes = a.inbox.slice(before).filter((record) => record.type === "loaded_surfaces_changed");
		expect(changes.map((record) => record.sessionId)).toEqual([s1.sessionId, s3OnA.sessionId]);
	});
});
