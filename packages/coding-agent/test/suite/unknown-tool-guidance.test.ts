import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("unknown tool names guide the caller back", () => {
	it("a misspelled tool name names the active tools, including the intended one", async () => {
		const harness = await createHarness();
		try {
			harness.session.setActiveToolsByName(["read", "bash", "edit"]);
			const error = await harness.session.executeTool("reed", {}).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(Error);
			const message = error instanceof Error ? error.message : "";
			expect(message).toMatch(/^Unknown tool reed\. Active tools: .*\bread\b/u);
		} finally {
			harness.cleanup();
		}
	});
});
