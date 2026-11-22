import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { opened } from "../rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-3072-shared-"));
	directories.push(dir);
	return dir;
}

const commands = [
	{ type: "eval_cells.list" },
	{ type: "eval_cells.peek", cellId: "cell" },
	{ type: "eval_cells.stop", cellId: "cell" },
] satisfies RpcCommand[];

it.each(commands)("delivers $type through the shared host while foreign-held", async (command) => {
	const dir = await directory();
	const delivered: string[] = [];
	await using rig = createInProcessRig(dir, undefined, async (value) => {
		delivered.push(value.type);
	});
	const session = opened(await rig.open("owner", { cwd: dir }), 0);
	const turn = rig.turns.get(session.state.sessionFile);
	if (!turn) throw new Error("Session did not open");
	turn.finish();
	await using holder = await startSessionHolder(session.state.sessionFile, session.state.sessionId, dir);

	await rig.send("owner", { ...command, id: "control", sessionId: session.sessionId });

	expect(holder.pid).not.toBe(process.pid);
	expect(delivered).toEqual([command.type]);
	expect(
		await rig.send("owner", {
			type: "set_session_name",
			id: "write",
			sessionId: session.sessionId,
			name: "blocked",
		}),
	).toMatchObject({ success: false, errorCode: "session_held" });
});

it.each(commands)("classifies $type activity through the shared host's idle sweep", async (command) => {
	const dir = await directory();
	let now = 0;
	const delivered: string[] = [];
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 1_000 }, async (value) => {
		delivered.push(value.type);
	});
	const session = opened(await rig.open("owner", { cwd: dir, retain_on_disconnect: true }), 0);
	const entry = rig.registry.peek(session.sessionId);
	if (!entry) throw new Error("Session did not open");
	await rig.drop("owner");
	now = 999;

	await rig.send("observer", { ...command, id: "control", sessionId: session.sessionId });
	now = 1_000;
	rig.router.sweepIdleSessions();

	expect(delivered).toEqual([command.type]);
	if (command.type === "eval_cells.stop") {
		expect(entry.state).toBe("open");
		now = 1_999;
		rig.router.sweepIdleSessions();
	}
	expect(entry.state).toBe("closing");
	await entry.closeCompletion;
	expect(rig.registry.peek(session.sessionId)).toBeUndefined();
});

it("advertises eval cell controls on the shared host before opening a session", async () => {
	const dir = await directory();
	await using rig = createInProcessRig(dir);
	expect(await rig.send("client", { id: "info", type: "get_protocol_info" })).toMatchObject({
		success: true,
		data: { capabilities: expect.arrayContaining(["eval_cells"]) },
	});
});
