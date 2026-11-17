import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { UNRUN_AFTER_ERROR } from "../../../src/modes/interactive/aborted-error-label.ts";
import { explorationSurface, invoke } from "../exploration-surface-harness.ts";

// senpi#5064: a tool call that never ran because the turn failed must not repeat the raw provider error;
// live and replay render the same card text with real tool cards. (This surface does not emit the live turn-end
// notice, so only the error case compares the card section rather than the whole screen.)
const RAW =
	'429 {"error":{"message":"You\'ve reached your monthly usage limit","type":"exceeded_current_quota_error"}}';

function failedTurn(stopReason: "aborted" | "error"): AssistantMessage {
	const calls = ["one", "two"].map(
		(id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }) as const,
	);
	return {
		...fauxAssistantMessage(""),
		content: [...calls],
		stopReason,
		errorMessage: stopReason === "error" ? RAW : "Operation aborted",
	};
}

async function liveAndReplay(message: AssistantMessage): Promise<{ live: string; replay: string }> {
	const live = await explorationSurface();
	const replay = await explorationSurface();
	try {
		const mutable = { ...message, content: [...message.content] };
		await live.event({ type: "message_start", message: mutable });
		for (const [contentIndex, toolCall] of mutable.content.entries()) {
			if (toolCall.type !== "toolCall") continue;
			await live.event({
				type: "message_update",
				message: mutable,
				assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall, partial: mutable },
			});
		}
		await live.event({ type: "message_end", message: mutable });
		invoke(replay.mode, "renderSessionItems", [mutable]);
		invoke(live.mode, "setToolsExpanded", true);
		invoke(replay.mode, "setToolsExpanded", true);
		return { live: live.text(), replay: replay.text() };
	} finally {
		live.cleanup();
		replay.cleanup();
	}
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("a tool call the failed turn never ran (senpi#5064)", () => {
	it("says it was not run instead of repeating the raw provider error, live and on replay", async () => {
		const { live, replay } = await liveAndReplay(failedTurn("error"));
		for (const surface of [live, replay]) {
			expect(occurrences(surface, UNRUN_AFTER_ERROR)).toBe(2);
			expect(surface).not.toContain("exceeded_current_quota_error");
		}
		const cards = (screen: string): string => screen.slice(screen.indexOf("Explored"));
		expect(cards(replay)).toBe(cards(live));
	});

	it("keeps the abort label on the cards of an aborted turn", async () => {
		const { live, replay } = await liveAndReplay(failedTurn("aborted"));
		expect(live).toContain("Operation aborted");
		expect(live).not.toContain(UNRUN_AFTER_ERROR);
		expect(replay).toBe(live);
	});
});
