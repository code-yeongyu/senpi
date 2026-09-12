import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

/**
 * Regression for #1005: team-mode goal continuations used to be filtered down to
 * the newest one on every provider request, which rewrote already-sent history
 * and invalidated the provider's conversation cache prefix (cache miss per turn,
 * full re-read, 429 storms). Continuations must now be append-only: the message
 * array of request N stays a verbatim prefix of request N+1.
 */
describe("issue #1005: goal continuations keep the provider cache prefix stable", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function payloadMessages(harness: Harness, callIndex: number): Message[] {
		const call = harness.faux.getCallLog()[callIndex];
		expect(call).toBeDefined();
		return call.context.messages;
	}

	it("keeps payload N a verbatim prefix of payload N+1 across continuations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("assistant-1"),
			fauxAssistantMessage("assistant-2"),
			fauxAssistantMessage("assistant-3"),
		]);

		// Establish a prefix: user turn + assistant reply.
		await harness.session.prompt("user-0");

		// First continuation triggers its own turn (team-mode wake).
		await harness.session.sendCustomMessage(
			{ customType: "goal-continuation", content: "continuation-1", display: false, details: undefined },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		const payloadA = payloadMessages(harness, 1);

		// A hidden non-goal custom message lands in between, then a second continuation.
		await harness.session.sendCustomMessage(
			{ customType: "goal-notification", content: "hidden-note", display: false, details: undefined },
			{ triggerTurn: false },
		);
		await harness.session.sendCustomMessage(
			{ customType: "goal-continuation", content: "continuation-2", display: false, details: undefined },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		const payloadB = payloadMessages(harness, 2);

		// payload A must survive verbatim as the head of payload B.
		expect(payloadB.length).toBeGreaterThan(payloadA.length);
		expect(payloadB.slice(0, payloadA.length)).toEqual(payloadA);

		// Everything appended after the shared prefix is new user-side context, and
		// the newest continuation is the final turn the provider sees.
		const appended = payloadB.slice(payloadA.length);
		expect(appended.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
		expect(appended.map(getMessageText)).toContain("continuation-2");
		expect(getMessageText(payloadB[payloadB.length - 1])).toBe("continuation-2");

		// The earlier continuation is still present in the shared prefix.
		expect(payloadA.map(getMessageText)).toContain("continuation-1");
		expect(payloadB.map(getMessageText)).toContain("continuation-1");
	});

	it("appends exactly one final user turn per continuation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("assistant-1"),
			fauxAssistantMessage("assistant-2"),
			fauxAssistantMessage("assistant-3"),
		]);

		await harness.session.prompt("user-0");
		await harness.session.sendCustomMessage(
			{ customType: "goal-continuation", content: "continuation-1", display: false, details: undefined },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		const payloadA = payloadMessages(harness, 1);

		await harness.session.sendCustomMessage(
			{ customType: "goal-continuation", content: "continuation-2", display: false, details: undefined },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		const payloadB = payloadMessages(harness, 2);

		expect(payloadB.slice(0, payloadA.length)).toEqual(payloadA);
		// prior assistant reply + the new continuation user turn
		const appended = payloadB.slice(payloadA.length);
		expect(appended.filter((message) => message.role === "user").map(getMessageText)).toEqual(["continuation-2"]);
	});
});
