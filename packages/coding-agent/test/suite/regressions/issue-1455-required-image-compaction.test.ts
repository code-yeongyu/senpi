import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness } from "../harness.ts";
import { createCompactionImage } from "./issue-1455-image-fixture.ts";

it("persists required image compaction after a classified summarizer failure (#1455)", async () => {
	// Given: the real session pipeline has a large valid image and a failing summarizer.
	const image = createCompactionImage();
	const harness = await createHarness({
		models: [{ id: "image-budget", contextWindow: 1_000_000, maxTokens: 4096, input: ["text", "image"] }],
		persistSession: true,
		extensionFactories: [compactionExtension],
		settings: {
			compaction: {
				enabled: true,
				speculativeEnabled: false,
				idleCompactionEnabled: false,
				keepRecentTokens: 1000,
				reserveTokens: 100,
				reserveScalingEnabled: false,
			},
		},
	});
	try {
		harness.sessionManager.appendMessage({ role: "user", content: "Inspect the image.", timestamp: 1 });
		const boundary = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 2, stopReason: "toolUse" }),
			content: [{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "fixture.png" } }],
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "read-image",
			toolName: "read",
			content: [image],
			isError: false,
			timestamp: 3,
		});
		harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: Responses stream ended before a terminal event",
			}),
		]);
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fixture session");
		const original = readFileSync(sessionFile, "utf8");

		// When: normal manual compaction reaches the builtin failure recovery path.
		const result = await harness.session.compact();

		// Then: the engine commits the original image and tool pair at the prepared boundary.
		expect(result).toMatchObject({
			firstKeptEntryId: boundary,
			details: { origin: "required-compaction-recovery", failureKind: "upstream-stream-truncated" },
		});
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ accepted: true, aborted: false }),
		);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const retained = harness.session.messages.find((message) => message.role === "toolResult");
		expect(retained).toMatchObject({ toolCallId: "read-image", content: [image] });
		expect(readFileSync(sessionFile, "utf8").startsWith(original)).toBe(true);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	} finally {
		harness.cleanup();
	}
});
