// senpi#5867 review of #6032: a hand's tool outcome is acknowledged only after the session durably recorded its result
// message. The session's `messageRecorded` resolves once the message_end write produced an entry, and rejects when the
// transcript write failed.
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function ranToolResult(failToolResultWrite: boolean) {
	const harness = await createHarness({
		persistSession: true,
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "record_probe",
					label: "probe",
					description: "fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	if (failToolResultWrite) {
		const append = harness.sessionManager.appendOwnedMessage.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendOwnedMessage").mockImplementation((message, options) => {
			if (message.role === "toolResult") throw new Error("disk full");
			return append(message, options);
		});
	}
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("record_probe", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	// A failed transcript write is reported to the run's owner, so the prompt itself may reject; the message still ran.
	await harness.session.prompt("run").catch((error: unknown) => {
		if (!failToolResultWrite) throw error;
	});
	const result = harness.agent.state.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult",
	);
	if (result === undefined) throw new Error("the tool never produced a result message");
	return { harness, result };
}

/** A persisted session whose first header write is held: appends get entry ids while their bytes stay buffered. */
async function withHeldHeaderWrite(outcome: "lands" | "fails") {
	const harness = await createHarness({
		persistSession: true,
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "record_probe",
					label: "probe",
					description: "fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const gate = Promise.withResolvers<void>();
	const manager = harness.sessionManager as unknown as { _writeHeaderAsync(file: string): Promise<void> };
	const write = manager._writeHeaderAsync.bind(manager);
	vi.spyOn(manager, "_writeHeaderAsync").mockImplementation(async (file) => {
		await gate.promise;
		if (outcome === "fails") throw new Error("header write failed");
		return write(file);
	});
	const header = harness.sessionManager.persistHeaderNow();
	header.catch(() => undefined);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("record_probe", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("run").catch(() => undefined);
	const message = harness.agent.state.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
	if (message === undefined) throw new Error("the tool never produced a result message");
	return { harness, message, release: () => gate.resolve() };
}

it("stays pending while the first header write still holds the session file, then resolves once it lands", async () => {
	const { harness, message, release } = await withHeldHeaderWrite("lands");
	expect(harness.sessionManager.isTranscriptFlushed()).toBe(false);
	let settled: "resolved" | "rejected" | undefined;
	const recorded = harness.agent.messageRecorded?.(message).then(
		() => {
			settled = "resolved";
		},
		() => {
			settled = "rejected";
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(settled).toBeUndefined();

	release();
	await recorded;

	expect(settled).toBe("resolved");
	expect(harness.sessionManager.isTranscriptFlushed()).toBe(true);
});

it("rejects when the first header write the result was buffered behind fails", async () => {
	const { harness, message, release } = await withHeldHeaderWrite("fails");
	const recorded = harness.agent.messageRecorded?.(message);
	recorded?.catch(() => undefined);

	release();

	await expect(recorded).rejects.toThrow();
	expect(harness.sessionManager.isTranscriptFlushed()).toBe(false);
});

it("resolves for a tool result the session wrote to its transcript", async () => {
	const { harness, result } = await ranToolResult(false);

	await expect(harness.agent.messageRecorded?.(result)).resolves.toBeUndefined();
});

it("rejects for a tool result whose transcript write failed", async () => {
	const { harness, result } = await ranToolResult(true);

	await expect(harness.agent.messageRecorded?.(result)).rejects.toThrow("transcript_write_failed");
});
