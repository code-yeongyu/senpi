import { expect, it, vi } from "vitest";
import { controlData } from "../../../test/helpers/session-control-client.ts";
import { startEndpoint } from "../../../test/helpers/session-control-fixture.ts";
import { dataOf, statusHost } from "../../../test/suite/rpc-session-status-support.ts";

// #4266: the source cursor, not the response arrival, divides snapshot from live records.
it("places a microtask record after the marker but before the snapshot response", async () => {
	await using rig = await statusHost();
	const owner = rig.client("owner");
	const observer = rig.client("observer");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: rig.cwd })).sessionId);
	await observer.request({ type: "subscribe_sessions", mirror: "all", observe: true });
	const enqueue = rig.writer.enqueue.bind(rig.writer);
	const spy = vi.spyOn(rig.writer, "enqueue").mockImplementation((id, record) => {
		const result = enqueue(id, record);
		if ("type" in record && record.type === "snapshot_marker")
			queueMicrotask(() => enqueue(id, { type: "cursor_test_delta" }));
		return result;
	});
	try {
		const snapshot = dataOf(await observer.request({ type: "get_snapshot", sessionId, observe: true }));
		const marker = observer.inbox.findIndex((r) => r.type === "snapshot_marker" && r.markerId === snapshot.markerId);
		const delta = observer.inbox.findIndex((r) => r.type === "cursor_test_delta");
		const response = observer.inbox.findIndex((r) => r.type === "response" && r.command === "get_snapshot");
		expect(marker).toBeGreaterThanOrEqual(0);
		expect(delta).toBeGreaterThan(marker);
		expect(response).toBeGreaterThan(delta);
		// Negative control: using response order drops this real post-snapshot record.
		expect(observer.inbox.slice(response + 1).some((r) => r.type === "cursor_test_delta")).toBe(false);
	} finally {
		spy.mockRestore();
	}
});

it("sends each subscribed connection only its own marker and none to a plain reader", async () => {
	await using rig = await statusHost();
	const owner = rig.client("owner");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: rig.cwd })).sessionId);
	const a = rig.client("a");
	const b = rig.client("b");
	await a.request({ type: "subscribe_sessions", mirror: ["message_update"], observe: true });
	await b.request({ type: "subscribe_sessions", mirror: "all", observe: true });
	const sa = dataOf(await a.request({ type: "get_snapshot", sessionId }));
	const sb = dataOf(await b.request({ type: "get_snapshot", sessionId }));
	await owner.request({ type: "get_snapshot", sessionId });
	expect(a.inbox.filter((r) => r.type === "snapshot_marker").map((r) => r.markerId)).toEqual([sa.markerId]);
	expect(b.inbox.filter((r) => r.type === "snapshot_marker").map((r) => r.markerId)).toEqual([sb.markerId]);
	expect(owner.inbox.some((r) => r.type === "snapshot_marker")).toBe(false);
});

it("returns the newest bounded tail in chronological order and rejects invalid bounds", async () => {
	await using rig = await statusHost();
	const owner = rig.client("owner");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: rig.cwd })).sessionId);
	for (const text of ["first", "second", "third"])
		await owner.request({ type: "append_user_message", sessionId, content: text });
	const history = dataOf(await owner.request({ type: "get_entries", sessionId }));
	if (!Array.isArray(history.entries)) throw new Error("missing history");
	const snapshot = dataOf(await owner.request({ type: "get_snapshot", sessionId, tail: 2 }));
	expect(snapshot.entries).toEqual(history.entries.slice(-2));
	expect(snapshot).toMatchObject({ history_truncated: true, next_before: history.entries.at(-2).id });
	const empty = dataOf(await owner.request({ type: "get_snapshot", sessionId, maxBytes: 1 }));
	expect(empty.entries).toEqual([]);
	expect(empty.history_truncated).toBe(true);
	for (const tail of [-1, 1.5, "two"])
		expect(await owner.request({ type: "get_snapshot", sessionId, tail })).toMatchObject({ success: false });
});

it("serves the same snapshot contract from a terminal control endpoint", async () => {
	const fixture = await startEndpoint();
	try {
		const snapshot = await controlData(fixture.socket, {
			type: "get_snapshot",
			sessionId: fixture.harness.session.sessionId,
		});
		expect(snapshot).toMatchObject({
			state: { sessionId: fixture.harness.session.sessionId },
			history_truncated: false,
			next_before: null,
		});
	} finally {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});
