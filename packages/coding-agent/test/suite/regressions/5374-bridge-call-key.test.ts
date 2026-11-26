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
const assistant = (content: AssistantMessage["content"]): AssistantMessage =>
	fauxAssistantMessage(content, { stopReason: "toolUse", timestamp: 1 });

/** The producer's execution start: the key it carries to the host, if it minted one. */
function started(producer: BridgedCallKeys): string | undefined {
	const execution = { ...start };
	producer.observe(execution);
	return executionCallKey(carryRecovery(execution, { ...execution }));
}

/** The keys the session file persists on `message`'s parts, with the producer's bridged calls. */
function persisted(message: AssistantMessage, messageId: string, producer: BridgedCallKeys): (string | undefined)[] {
	const dir = mkdtempSync(join(tmpdir(), "senpi-5374-bridge-"));
	dirs.push(dir);
	const session = SessionManager.create(dir, dir);
	session.appendMessage({ role: "user", content: "go", timestamp: 0 });
	session.appendOwnedMessage(message, { recoveryOwner: { messageId, epoch: "e" }, bridgedCalls: producer.take() });
	const lines = readFileSync(session.getSessionFile() ?? expect.unreachable("no file"), "utf8")
		.trim()
		.split("\n");
	const entry = lines.map((line) => JSON.parse(line)).find((line) => line.message?.role === "assistant");
	return (entry?.message.content ?? []).map((part: { runtimeItemKey?: string }) => part.runtimeItemKey);
}

async function withRig(run: (rig: Awaited<ReturnType<typeof callsRig>>) => Promise<void>): Promise<void> {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		await run(rig);
	} finally {
		await rig.close();
	}
}

it.each(["block-first", "bridge-first"] as const)(
	"RULING-127 (b) #5374 %s: one call, one key, live == persisted",
	(order) =>
		withRig(async (rig) => {
			const owner = rig.start();
			const producer = new BridgedCallKeys();
			const message = assistant([call]);
			producer.observe({ type: "message_start", message: { ...message, content: [] } });
			if (order === "block-first") producer.observe({ type: "message_update", message });
			const carried = started(producer);
			if (order === "bridge-first") producer.observe({ type: "message_update", message });
			producer.observe({ type: "message_end", message });
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
			const key = order === "block-first" ? blockCallKey(owner.messageId, 0) : carried;
			expect(view.calls).toHaveLength(1);
			expect(view.calls[0]).toMatchObject({
				runtimeItemKey: key,
				owningMessageId: owner.messageId,
				contentIndex: 0,
			});
			expect(view.calls[0]).not.toHaveProperty("callUnknown");
			expect(persisted(message, owner.messageId, producer)).toEqual([key]);
			rig.lane.release(view.root);
		}),
);

it("RULING-127 (b) #5374 a bridge-started call whose block appears only in the terminal keeps its first key", () =>
	withRig(async (rig) => {
		const owner = rig.start();
		const producer = new BridgedCallKeys();
		const message = assistant([call]);
		producer.observe({ type: "message_start", message: { ...message, content: [] } });
		const carried = started(producer);
		producer.observe({ type: "message_end", message });
		rig.lane.accept(start, undefined, undefined, false, carried);
		rig.end(owner, [call]);
		const view = await rig.calls();
		expect(view.calls.map((each) => [each.runtimeItemKey, each.owningMessageId, each.contentIndex])).toEqual([
			[carried, owner.messageId, 0],
		]);
		expect(persisted(message, owner.messageId, producer)).toEqual([carried]);
		rig.lane.release(view.root);
	}));

it("RULING-127 (b) #5374 two bridge-started calls reusing one id join their blocks oldest first, each keeping its key", () =>
	withRig(async (rig) => {
		const owner = rig.start();
		const producer = new BridgedCallKeys();
		const message = assistant([call, call]);
		producer.observe({ type: "message_start", message: { ...message, content: [] } });
		const first = started(producer);
		const second = started(producer);
		producer.observe({ type: "message_update", message });
		producer.observe({ type: "message_end", message });
		expect(first).toMatch(/^exe:/);
		expect(second).toMatch(/^exe:/);
		rig.lane.accept(start, undefined, undefined, false, first);
		rig.lane.accept(start, undefined, undefined, false, second);
		rig.toolStart(owner, 0, call, "bash");
		rig.toolStart(owner, 1, call, "bash");
		rig.end(owner, [call, call]);
		const view = await rig.calls();
		const byBlock = [...view.calls].sort((a, b) => (a.contentIndex ?? -1) - (b.contentIndex ?? -1));
		expect(byBlock.map((each) => [each.contentIndex, each.runtimeItemKey])).toEqual([
			[0, first],
			[1, second],
		]);
		expect(persisted(message, owner.messageId, producer)).toEqual([first, second]);
		rig.lane.release(view.root);
	}));

it("RULING-127 (b) #5374 a bridged start never joins a block an earlier turn left unstarted", () =>
	withRig(async (rig) => {
		const stale = rig.start();
		rig.toolStart(stale, 0, call, "bash");
		rig.toolEnd(stale, 0, call, "bash");
		rig.end(stale, [call]);
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const producer = new BridgedCallKeys();
		const message = assistant([call]);
		producer.observe({ type: "message_start", message: { ...message, content: [] } });
		const carried = started(producer);
		producer.observe({ type: "message_update", message });
		producer.observe({ type: "message_end", message });
		expect(carried).toMatch(/^exe:/);
		rig.lane.accept(start, undefined, undefined, false, carried);
		rig.toolStart(owner, 0, call, "bash");
		rig.end(owner, [call]);
		const view = await rig.calls();
		const of = (messageId: string) => view.calls.find((each) => each.owningMessageId === messageId);
		expect(of(owner.messageId)?.runtimeItemKey).toBe(carried);
		expect(of(stale.messageId)).toMatchObject({
			runtimeItemKey: blockCallKey(stale.messageId, 0),
			startSequence: null,
			phase: "awaiting-execution",
		});
		expect(persisted(message, owner.messageId, producer)).toEqual([carried]);
		rig.lane.release(view.root);
	}));
