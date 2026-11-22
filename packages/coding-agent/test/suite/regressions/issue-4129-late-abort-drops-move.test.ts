import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { nextEvent } from "../rpc-release-host-support.ts";
import { relocationRig, stillWritableHere } from "../rpc-relocate-session-support.ts";

describe("a user abort that lands after agent_end, before the run settles (#4129)", () => {
	it("drops the scheduled move as aborted, once, and announces no move", async () => {
		// Given: the tool scheduled a move and the closing response finishes on its own.
		const rig = await relocationRig({
			capabilities: ["session_relocation"],
			host: () => ({ data: { accepted: true, moveId: "mv-late", target: "Studio" } }),
		});
		try {
			rig.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "heavy build" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const toolDone = nextEvent(rig.harness.session, "tool_execution_end");
			const late: Promise<void>[] = [];
			const stop = rig.harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				stop();
				// When: the user's abort arrives at agent_end, while the run has not settled yet.
				late.push(rig.handler.handleInputLine(JSON.stringify({ type: "abort", id: "abort-late" })));
			});
			const turn = rig.harness.session.prompt("continue on Studio");
			await toolDone;
			await turn;
			await Promise.all(late);
			await rig.harness.session.agent.waitForIdle();

			// Then: exactly one typed correction, the session stays writable here, no relocation_due.
			const outcomes = rig.harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "session_relocation",
			);
			expect(outcomes).toEqual([
				expect.objectContaining({
					details: expect.objectContaining({ status: "dropped", reason: "aborted", moveId: "mv-late" }),
				}),
			]);
			await stillWritableHere(rig);
			expect(rig.records.filter((record) => record.type === "relocation_due")).toEqual([]);
		} finally {
			await rig.cleanup();
		}
	});
});
