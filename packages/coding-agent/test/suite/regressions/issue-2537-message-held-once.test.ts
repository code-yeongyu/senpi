import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * senpi#2537: a long session's heap grew with every turn because each message was held twice, once in
 * the agent's context and once as a JSON copy in the session mirror. A message the session persisted is
 * now held once: the mirror's message is a shallow copy sharing the agent's content, and both still
 * read exactly what the session file holds.
 */
type OwnedMessage = Parameters<SessionManager["appendOwnedMessage"]>[0];

/** A three-slot array whose middle slot is a hole (JSON writes it as null). */
function sparse(first: number, last: number): number[] {
	const list = new Array<number>(3);
	list[0] = first;
	list[2] = last;
	return list;
}

describe("issue #2537: a persisted message is held once", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function mirrorMessages(harness: Harness): unknown[] {
		return harness.sessionManager
			.getEntries()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map((entry) => entry.message);
	}

	it("shares each message's content between the agent context and the session mirror", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("a short reply")]);

		await harness.session.prompt("hello there");

		const live = harness.session.messages.filter(
			(message) => message.role === "user" || message.role === "assistant",
		);
		const mirrored = mirrorMessages(harness) as { content: unknown }[];
		expect(live).toHaveLength(2);
		// The message's content, its bulk, is one array shared by the agent and the mirror.
		for (const message of live) {
			expect(mirrored.some((entry) => entry.content === (message as { content: unknown }).content)).toBe(true);
		}
	});

	it("keeps the mirror equal to a cold reload of the session file", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const file = harness.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("the harness session is not persisted to a file");
		const reloaded = SessionManager.open(file);
		expect(JSON.parse(JSON.stringify(mirrorMessages(harness)))).toEqual(
			reloaded
				.getEntries()
				.filter((entry): entry is SessionMessageEntry => entry.type === "message")
				.map((entry) => entry.message),
		);
	});

	it("keeps the mirror equal to the file when a failed turn gets its post-save note", async () => {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "invalid_image: does not represent a valid image",
			}),
		]);
		await harness.session.prompt("look", { images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }] });

		const live = harness.session.messages.at(-1);
		expect(live?.role === "assistant" && live.errorMessage).toContain("is left out of later requests");
		const file = harness.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("the harness session is not persisted to a file");
		const reloaded = SessionManager.open(file)
			.getEntries()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map((entry) => entry.message);
		expect(JSON.parse(JSON.stringify(mirrorMessages(harness)))).toEqual(reloaded);
	});

	it.each([
		["a Date", { when: new Date(0) }, { when: "1970-01-01T00:00:00.000Z" }],
		["NaN", { ratio: Number.NaN }, { ratio: null }],
		["Infinity", { ratio: Number.POSITIVE_INFINITY }, { ratio: null }],
		["a class instance", { set: new Set([1]) }, { set: {} }],
		["a sparse array", { list: sparse(1, 3) }, { list: [1, null, 3] }],
	] as const)("keeps the JSON copy for a message holding %s", (_name, details, reloaded) => {
		const manager = SessionManager.inMemory();
		const message = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: 1,
		};
		const id = manager.appendOwnedMessage(message as unknown as OwnedMessage);
		const stored = (manager.getEntry(id) as SessionMessageEntry).message as unknown as {
			content: unknown;
			details: unknown;
		};
		// What a cold reload reads.
		expect(stored.details).toEqual(reloaded);
		expect(stored.content).not.toBe(message.content);
	});

	it("keeps the JSON copy for a message with a resident string, so the idle release cannot leak a token", () => {
		const manager = SessionManager.inMemory();
		const big = "x".repeat(40 * 1024);
		const message = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text" as const, text: big }],
			isError: false,
			timestamp: 1,
		};
		const id = manager.appendOwnedMessage(message);
		// The idle release tokenizes the agent's live messages in place.
		manager.getResidentStore().externalizeInPlace([message]);
		const stored = (manager.getEntry(id) as SessionMessageEntry).message as { content: { text: string }[] };
		expect(stored.content[0]?.text).toBe(big);
		const projected = manager.buildSessionContext().messages.at(-1) as { content: { text: string }[] };
		expect(projected.content[0]?.text).toBe(big);
	});
});
