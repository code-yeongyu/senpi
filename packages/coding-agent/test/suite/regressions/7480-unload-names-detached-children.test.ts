import { afterEach, describe, expect, it } from "vitest";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";

// senpi#7480: `unload_session { children: "detach" }` left the child sessions running but did not name them, so a
// caller could only list them before the unload, a read a child can start or end around. The `unloaded` answer names
// them, read in the step that claims the close, and the unload's receipt in the session file names the same ones.

const hosts: Array<AsyncDisposable> = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host[Symbol.asyncDispose]();
});

async function host() {
	const created = await statusHost({ deadlineMs: 20_000 });
	hosts.push(created);
	return created;
}

async function durableIdOf(client: RawClient, sessionId: string): Promise<string> {
	const data = dataOf(await client.request({ type: "subscribe_sessions" }));
	const row = (data.snapshot as WireRecord[]).find((record) => record.sessionId === sessionId);
	if (row === undefined) throw new Error(`session ${sessionId} is not listed`);
	return String(row.durableSessionId);
}

describe('unload_session { children: "detach" } names the children it left running (senpi#7480)', () => {
	it("names each child session open on this host, and its receipt names the same ones", async () => {
		const rig = await host();
		const client = rig.client("A");
		const parent = String(dataOf(await client.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const durable = await durableIdOf(client, parent);
		const open = async (context: Record<string, string>) =>
			String(dataOf(await client.request({ type: "open_session", cwd: rig.cwd, context })).sessionId);
		const child = await open({ parent_session_id: durable });
		const grandchild = await open({ parent_session_id: child, root_session_id: durable });
		const unrelated = await open({ parent_session_id: "another-session" });
		const unload = { type: "unload_session", sessionId: parent, force: true, children: "detach", effectId: "u1" };

		const answer = dataOf(await client.request(unload));
		const receipt = dataOf(
			await client.request({ type: "get_effect_status", effectId: "u1", sessionPath: String(answer.sessionPath) }),
		);

		expect(answer).toMatchObject({ outcome: "unloaded" });
		expect([...(answer.detached as string[])].sort()).toEqual([child, grandchild].sort());
		expect(receipt).toMatchObject({ effect: { state: "done", disposition: "unloaded", detached: answer.detached } });
		for (const sessionId of [child, grandchild, unrelated])
			expect(await client.request({ type: "get_state", sessionId })).toMatchObject({ success: true });
	});

	it("does not name a child whose close finished before the unload", async () => {
		const rig = await host();
		const client = rig.client("A");
		const parent = String(dataOf(await client.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const durable = await durableIdOf(client, parent);
		const open = async () =>
			String(
				dataOf(
					await client.request({ type: "open_session", cwd: rig.cwd, context: { parent_session_id: durable } }),
				).sessionId,
			);
		const kept = await open();
		const closed = await open();
		expect(dataOf(await client.request({ type: "unload_session", sessionId: closed, force: true }))).toMatchObject({
			outcome: "unloaded",
		});

		const answer = dataOf(
			await client.request({ type: "unload_session", sessionId: parent, force: true, children: "detach" }),
		);

		expect(answer).toMatchObject({ outcome: "unloaded", detached: [kept] });
	});

	it("names none when the session has no child open on this host", async () => {
		const rig = await host();
		const client = rig.client("A");
		const parent = String(dataOf(await client.request({ type: "open_session", cwd: rig.cwd })).sessionId);

		const answer = dataOf(
			await client.request({ type: "unload_session", sessionId: parent, force: true, children: "detach" }),
		);

		expect(answer).toMatchObject({ outcome: "unloaded", detached: [] });
	});

	it("adds no detached key when the unload did not ask to detach children, live or on the receipt", async () => {
		const rig = await host();
		const client = rig.client("A");
		const parent = String(dataOf(await client.request({ type: "open_session", cwd: rig.cwd })).sessionId);

		const answer = dataOf(
			await client.request({ type: "unload_session", sessionId: parent, force: true, effectId: "plain" }),
		);
		const receipt = dataOf(
			await client.request({
				type: "get_effect_status",
				effectId: "plain",
				sessionPath: String(answer.sessionPath),
			}),
		);

		expect(answer).toMatchObject({ outcome: "unloaded" });
		expect(Object.keys(answer)).not.toContain("detached");
		expect(receipt).toMatchObject({ effect: { state: "done", disposition: "unloaded" } });
		expect(Object.keys(receipt.effect as WireRecord)).not.toContain("detached");
	});

	// A replay answers from the stored receipt: the same keyed unload sent again to the reopened session.
	async function unloadThenReplay(children: "detach" | undefined, effectId: string) {
		const rig = await host();
		const client = rig.client("A");
		const parent = String(dataOf(await client.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const durable = await durableIdOf(client, parent);
		// Only a detach may leave a child open: a plain unload would be refused children_live.
		if (children === "detach")
			await client.request({ type: "open_session", cwd: rig.cwd, context: { parent_session_id: durable } });
		const unload = { type: "unload_session", force: true, effectId, ...(children === undefined ? {} : { children }) };
		const first = dataOf(await client.request({ ...unload, sessionId: parent }));
		const reopened = dataOf(await client.request({ type: "open_session", sessionPath: String(first.sessionPath) }));
		const replay = dataOf(await client.request({ ...unload, sessionId: String(reopened.sessionId) }));
		return { first, replay };
	}

	it("replays a detach from its receipt with the first answer's detached", async () => {
		const { first, replay } = await unloadThenReplay("detach", "replay-detach");

		expect(first).toMatchObject({ outcome: "unloaded" });
		expect(first.detached).toHaveLength(1);
		expect(replay).toMatchObject({ outcome: "unloaded", replayed: true, detached: first.detached });
	});

	it("replays a plain unload from its receipt with no detached key", async () => {
		const { first, replay } = await unloadThenReplay(undefined, "replay-plain");

		expect(first).toMatchObject({ outcome: "unloaded" });
		expect(replay).toMatchObject({ outcome: "unloaded", replayed: true });
		expect(Object.keys(replay)).not.toContain("detached");
	});
});
