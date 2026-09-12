import { describe, expect, it } from "vitest";
import { buildContinuationPrompt, buildGoalStallNotice } from "../../src/core/extensions/builtin/goal/prompt.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";

describe("goal question routing", () => {
	it("renders the question tool as a legal continuation ending", () => {
		const prompt = buildContinuationPrompt({
			id: "g1",
			threadId: "t1",
			objective: "Ship it",
			status: "active",
			createdAt: 0,
			updatedAt: 0,
			timeUsedSeconds: 0,
			tokensUsed: 0,
		} satisfies Goal);
		expect(prompt).toContain("five ways");
		expect(prompt).toContain("question tool (request_user_input / ask_user_question)");
		expect(prompt).toContain("three goal turns since this goal became active or the user last spoke");
		expect(prompt).toContain("Retries are unbounded");
		expect(prompt).not.toContain("four ways");
	});

	it("routes user decisions in the live-source stall notice", () => {
		const notice = buildGoalStallNotice(3, { liveSources: ["terminal-monitors"] });
		expect(notice).toContain("waiting on a user decision, ask it with the question tool");
		expect(notice).not.toContain("another passive wait");
	});
});
