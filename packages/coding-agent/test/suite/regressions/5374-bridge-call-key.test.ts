import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { BridgedCallKeys, blockCallKey, executionCallKey } from "../../../src/core/session-call-keys.ts";
import { carryRecovery } from "../../../src/core/session-recovery-identity.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { callsRig } from "./4272-calls-support.ts";

// RULING-127 (b) (senpi#5374): the first key ever emitted for a call is its key forever. A call whose block streams
// before its execution starts takes the block's key; a bridge-started call (execution before its block) takes the key
// the producer minted with its start and keeps it when its block joins, and the file persists that same key. Never
// callUnknown: the call is known, only its key source differs.

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const call = fauxToolCall("bash", { command: "x" }, { id: "b1" });
const start = { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "x" } };

/** The producer half: the events of one assistant stream in `order`, then the part key the session file persists. */
function produce(order: "block-first" | "bridge-first", messageId: string) {
	const producer = new BridgedCallKeys();
	const message: AssistantMessage = fauxAssistantMessage([call], { stopReason: "toolUse", timestamp: 1 });
	const execution = { ...start };
	producer.observe({ type: "message_start", message: { ...message, content: [] } });
	if (order === "block-first") producer.observe({ type: "message_update", message });
	producer.observe(execution);
	const carried = executionCallKey(carryRecovery(execution, { ...execution }));
	if (order === "bridge-first") producer.observe({ type: "message_update", message });
	producer.observe({ type: "message_end", message });
	const dir = mkdtempSync(join(tmpdir(), "senpi-5374-bridge-"));
	dirs.push(dir);
	const session = SessionManager.create(dir, dir);
	session.appendMessage({ role: "user", content: "go", timestamp: 0 });
	session.appendOwnedMessage(message, { recoveryOwner: { messageId, epoch: "e" }, bridgedCalls: producer.take() });
	const lines = readFileSync(session.getSessionFile() ?? expect.unreachable("no file"), "utf8").trim().split("\n");
	const persisted = lines.map((line) => JSON.parse(line)).find((line) => line.message?.role === "assistant");
	return { carried, persisted: persisted?.message.content[0]?.runtimeItemKey as string | undefined };
}

it.each(["block-first", "bridge-first"] as const)("RULING-127 (b) #5374 %s: one call, one key, live == persisted", async (order) => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const { carried, persisted } = produce(order, owner.messageId);
		if (order === "block-first") {
			expect(carried).toBeUndefined();
			rig.toolStart(owner, 0, call, "bash");
			rig.lane.accept(start, undefined);
		} else {
			expect(carried).toMatch(/^exe:[0-9a-f-]{36}$/);
			rig.lane.accept(start, undefined, undefined, false, carried);
			rig.toolStart(owner, 0, call, "bash");
		}
		rig.toolEnd(owner, 0, call, "bash");
		rig.end(owner, [call]);
		const view = await rig.calls();
		expect(view.calls).toHaveLength(1);
		const key = order === "block-first" ? blockCallKey(owner.messageId, 0) : carried;
		expect(view.calls[0]).toMatchObject({ runtimeItemKey: key, owningMessageId: owner.messageId, contentIndex: 0 });
		expect(view.calls[0]).not.toHaveProperty("callUnknown");
		expect(persisted).toBe(key);
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});
