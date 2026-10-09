import { describe, expect, it } from "vitest";
import { buildUlwHeavyContext, measureSerializedPrompt } from "./anthropic-subscription-prompt-size-probe.ts";

describe("Claude SDK OAuth prompt size probe", () => {
	it("builds a fixture with the requested number of directive copies in raw user messages", () => {
		const ctx = buildUlwHeavyContext(5, 10);
		const userMsgs = ctx.messages.filter((m) => m.role === "user");
		expect(userMsgs.length).toBe(10);
		const withDirective = userMsgs.filter(
			(m) => typeof m.content === "string" && m.content.includes("<ultrawork-mode>"),
		);
		expect(withDirective.length).toBe(5);
	});

	it("reports a positive byte total for the heavy fixture without dedupe", () => {
		const ctx = buildUlwHeavyContext(5, 10);
		const { totalBytes } = measureSerializedPrompt(ctx, false);
		expect(totalBytes).toBeGreaterThan(80_000);
	});

	it("collapses the serialized directive count to one when dedupe is applied", () => {
		const ctx = buildUlwHeavyContext(5, 10);
		const raw = measureSerializedPrompt(ctx, false);
		const deduped = measureSerializedPrompt(ctx, true);
		expect(raw.directiveBlockCount).toBe(5);
		expect(deduped.directiveBlockCount).toBe(1);
		expect(deduped.totalBytes).toBeLessThan(raw.totalBytes);
	});
});
