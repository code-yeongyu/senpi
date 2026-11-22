import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { replaceImagesNamingTool } from "../../src/core/extensions/builtin/look-at/image-placeholder.ts";
import { getSessionContextEntryId, SessionManager } from "../../src/core/session-manager.ts";

const TEXT_ONLY_MODEL = {
	id: "main",
	name: "main",
	api: "faux",
	provider: "faux",
	baseUrl: "http://faux.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

describe("look_at image placeholders in the request context", () => {
	// Context stages that derive a message keep its session entry identity (senpi#2525): later
	// stages find checkpoint-owned messages by it.
	it("keeps the session entry identity of a message whose image it replaces", () => {
		const session = SessionManager.inMemory();
		const entryId = session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "what is this" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			timestamp: 1,
		});
		const messages = session.buildSessionContext().messages;

		const [replaced] = replaceImagesNamingTool(messages, TEXT_ONLY_MODEL, "look_at");

		expect(replaced).not.toBe(messages[0]);
		expect(getSessionContextEntryId(replaced)).toBe(entryId);
	});
});
