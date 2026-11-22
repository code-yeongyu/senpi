import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

const durableId = "29510000-0000-4000-8000-000000000001";
let root: string;
let file: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "held-writing-"));
	file = join(root, "session.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: durableId, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const commands = [
	{ type: "follow_up", message: "held" },
	{ type: "continue_from_leaf" },
	{ type: "send_custom_message", customType: "test", content: "held", display: false },
	{ type: "wake" },
	{ type: "compact" },
	{ type: "set_model", provider: "test", modelId: "test" },
	{ type: "cycle_model" },
	{ type: "set_thinking_level", level: "off" },
	{ type: "cycle_thinking_level" },
	{ type: "bash", command: "true" },
	{
		type: "record_bash_result",
		command: "true",
		result: { output: "", exitCode: 0, cancelled: false, truncated: false },
	},
	{ type: "edit_user_message", entryId: "entry", text: "held" },
	{ type: "edit_assistant_message", entryId: "entry", text: "held" },
	{ type: "set_session_name", name: "held" },
	{ type: "set_label", entryId: "entry", label: "held" },
	{ type: "append_user_message", content: "held" },
	{
		type: "append_session_entry",
		entry: { type: "session_info", id: "entry", parentId: null, timestamp: new Date(0).toISOString(), name: "held" },
	},
	{ type: "navigate_tree", entryId: "entry", summarize: true },
] satisfies RpcCommand[];

it.each(commands)("refuses held writing command $type before binding delivery and clears on exit", async (command) => {
	const delivered: string[] = [];
	await using rig = createInProcessRig(root, undefined, async (value) => {
		delivered.push(value.type);
	});
	await rig.open("client", { sessionPath: file });
	const sessionId = (await rig.list())[0]?.sessionId;
	if (!sessionId) throw new Error("Session did not open");
	await using holder = await startSessionHolder(file, durableId, root);
	const response = await rig.send("client", { ...command, id: "held", sessionId });
	expect(response).toMatchObject({ success: false, error: "session_held", errorCode: "session_held" });
	expect(response?.errorData).toEqual({ holders: [{ pid: holder.pid, cwd: root }] });
	expect(delivered).toEqual([]);
	await holder.stop();
	await rig.send("client", { ...command, id: "released", sessionId });
	expect(delivered).toEqual([command.type]);
});

it.each(["get_state", "abort", "clear_queue"] as const)("keeps %s available while foreign-held", async (type) => {
	const delivered: string[] = [];
	await using rig = createInProcessRig(root, undefined, async (value) => {
		delivered.push(value.type);
	});
	await rig.open("client", { sessionPath: file });
	const sessionId = (await rig.list())[0]?.sessionId;
	if (!sessionId) throw new Error("Session did not open");
	await using holder = await startSessionHolder(file, durableId, root);
	await rig.send("client", { type, id: "control", sessionId });
	expect(holder.pid).not.toBe(process.pid);
	expect(delivered).toEqual([type]);
});

it("refuses a new writing RPC when a holder arrives during an admitted turn", async () => {
	await using rig: ReturnType<typeof createInProcessRig> = createInProcessRig(root, undefined, async (command) => {
		if (command.type === "prompt") [...rig.turns.values()][0]?.start();
	});
	await rig.open("client", { sessionPath: file });
	const sessionId = (await rig.list())[0]?.sessionId;
	if (!sessionId) throw new Error("Session did not open");
	await rig.send("client", { type: "prompt", id: "admitted", sessionId, message: "local turn" });
	await using holder = await startSessionHolder(file, durableId, root);
	expect(holder.pid).not.toBe(process.pid);
	const turn = [...rig.turns.values()][0];
	if (!turn) throw new Error("Admitted turn missing");
	turn.finish();
	expect(await rig.send("client", { type: "set_session_name", id: "next", sessionId, name: "blocked" })).toMatchObject(
		{ error: "session_held" },
	);
});
