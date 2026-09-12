import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionStreamingError } from "../../../src/core/edited-assistant-message.ts";
import { userMsg } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

describe("tree navigation during an active response", () => {
	it("rejects navigation without changing the active leaf", async () => {
		const harness = await createHarness();
		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		let navigationResult: unknown;
		let leafUnchanged = false;

		try {
			// Navigate from inside the response factory, while the run is active.
			harness.setResponses([
				async () => {
					const activeLeafId = harness.sessionManager.getLeafId();
					navigationResult = await harness.session
						.navigateTree(targetId, { summarize: false })
						.catch((error) => error);
					leafUnchanged = activeLeafId !== targetId && harness.sessionManager.getLeafId() === activeLeafId;
					return fauxAssistantMessage("response");
				},
			]);
			await harness.session.prompt("second");

			expect(navigationResult).toBeInstanceOf(SessionStreamingError);
			expect((navigationResult as SessionStreamingError).code).toBe("streaming");
			expect((navigationResult as Error).message).toBe(
				"Wait for the current response to finish before navigating the session tree.",
			);
			expect(leafUnchanged).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
