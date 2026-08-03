import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("extension context agent dir", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("exposes the session agent dir on event contexts", async () => {
		let observed: string | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						observed = (ctx as { agentDir?: string }).agentDir;
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });

		expect(observed).toBe(join(harness.tempDir, "agent"));
	});
});
