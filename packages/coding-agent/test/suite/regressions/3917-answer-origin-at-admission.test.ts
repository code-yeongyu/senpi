import { afterEach, expect, it, vi } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { releaseQuestionInput } from "../../../src/core/question-input.ts";
import { getUserTexts, type Harness } from "../harness.ts";
import { heldHarness } from "./3853-review-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
	vi.restoreAllMocks();
});

// senpi#3917: an answer delivered while session_start handlers run is deferred by the session_start
// turn gate. Its origin is captured when the extension delivers it, so it still runs as a person's input.
it("keeps a person's origin for an answer deferred by the session_start gate", async () => {
	const activity = vi.spyOn(AgentSession.prototype, "recordUserActivity");
	const { h, release } = await heldHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					ctx.noteHeldWake?.("goal");
					releaseQuestionInput(ctx);
					pi.sendUserMessage("my answer", { deliverAs: "followUp" });
				});
			},
		],
	});
	harnesses.push(h);
	release.resolve();
	await h.session.waitForIdle();
	expect(getUserTexts(h)).toContain("my answer");
	expect(activity).toHaveBeenCalledWith("prompt");
});
