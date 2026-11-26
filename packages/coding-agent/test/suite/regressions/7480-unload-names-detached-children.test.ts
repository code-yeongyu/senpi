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
});
