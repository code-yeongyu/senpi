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

it("resolves for a tool result the session wrote to its transcript", async () => {
	const { harness, result } = await ranToolResult(false);

	await expect(harness.agent.messageRecorded?.(result)).resolves.toBeUndefined();
});

it("rejects for a tool result whose transcript write failed", async () => {
	const { harness, result } = await ranToolResult(true);

	await expect(harness.agent.messageRecorded?.(result)).rejects.toThrow("transcript_write_failed");
});
