import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

// Part of #4272 (S13w0, RULING-82 (1)): moving the per-destination write loop out of session-event-writer.ts changes
// no byte. A fixed record sequence goes through the real writer to an attached peer, a media-placeholders peer, a peer
// attached to nothing, a targeted reply and the stdio lane; what each destination receives is compared byte for byte
// with the stream generated from the pre-move writer (7263345172) and committed with the move
// (SENPI_RECORD_WRITER_GOLDEN=1 re-records it).

const FIXTURE = new URL("../../fixtures/4272-writer-destinations-golden.json", import.meta.url);
const IMAGE = { type: "image", data: "aGVsbG8gaW1hZ2UgYnl0ZXM=", mimeType: "image/png" };

afterEach(() => {
	vi.restoreAllMocks();
});

/** The fixed sequence: lifecycle broadcast, keyed deltas, an image tool result, targeted records, a settle. */
function sequence(writer: SessionEventWriter): void {
	const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
	writer.enqueue("s1", { type: "agent_start" });
	writer.enqueue("s1", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
	for (const text of ["a", "ab", "abc"])
		writer.enqueue("s1", {
			type: "message_update",
			message: assistant(text),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: text.slice(-1),
				partial: assistant(text),
			},
		});
	writer.enqueue("s1", { type: "message_end", message: assistant("abc") });
	writer.enqueue("s1", {
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "read",
		result: { content: [{ type: "text", text: "see image" }, IMAGE] },
		isError: false,
	});
	writer.withConnection("plain", () =>
		writer.enqueue("s1", { type: "response", id: "r-1", command: "get_state", success: true }),
	);
	writer.withConnection("media", () =>
		writer.enqueue("s1", {
			type: "extension_ui_request",
			id: "ui-1",
			method: "select",
			title: "pick",
			options: ["a"],
		}),
	);
	writer.enqueue("s1", { type: "agent_end", messages: [] });
	writer.enqueue("s1", { type: "agent_settled", reason: "idle" });
}

async function record(): Promise<Record<string, string>> {
	const received: Record<string, string> = { plain: "", media: "", unattached: "", stdio: "" };
	const writer = new SessionEventWriter(() => {});
	for (const id of ["plain", "media", "unattached"])
		writer.registerConnection(id, {
			writeRaw: (chunk) => void (received[id] += chunk),
			waitForBackpressure: async () => {},
		});
	writer.setConnectionCapabilities("media", ["media_placeholders"]);
	writer.attachConnectionToSession("plain", "s1");
	writer.attachConnectionToSession("media", "s1");
	sequence(writer);
	await writer.flush();
	for (const id of ["plain", "media", "unattached"]) writer.unregisterConnection(id);
	const stdio = new SessionEventWriter((chunk) => void (received.stdio += chunk));
	sequence(stdio);
	await stdio.flush();
	return received;
}

it("S13w0 RULING-82 (1) every destination receives exactly the bytes recorded before the write loop moved", async () => {
	const received = await record();
	if (process.env.SENPI_RECORD_WRITER_GOLDEN === "1")
		writeFileSync(FIXTURE, `${JSON.stringify(received, null, "\t")}\n`);
	const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
	expect(
		Object.values(recorded).every((bytes) => bytes.length > 0),
		"the recording covers every destination",
	).toBe(true);
	expect(received).toEqual(recorded);
});
