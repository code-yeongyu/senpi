import { afterEach, describe, expect, it, vi } from "vitest";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// OpenCode Go's documented base. The legacy https://opencode.ai/zen/go/v1 still proxies the
// OpenAI and Anthropic wires but has no route for native generate-content (404 HTML), senpi#3377.
const DOCUMENTED_BASE = "https://opencode.ai/inference/go";

describe("opencode-go base URL (senpi#3377)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("points every catalog row at the documented inference base", () => {
		const rows = opencodeGoProvider().getModels();
		expect(rows.length).toBeGreaterThan(0);

		const offBase = rows.filter(
			(model) => !model.baseUrl.startsWith(`${DOCUMENTED_BASE}/`) && model.baseUrl !== DOCUMENTED_BASE,
		);

		expect(offBase.map((model) => `${model.id} ${model.baseUrl}`)).toEqual([]);
	});

	it("sends a native generate-content row to the documented base with the session header", async () => {
		// Given: a native-wire row and a fetch that records the request, then refuses it.
		const nativeRow = opencodeGoProvider()
			.getModels()
			.find((model) => model.api === "google-generative-ai");
		expect(nativeRow).toBeDefined();
		if (!nativeRow) return;
		const requests: { url: string; headers: Headers }[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push({ url: request.url, headers: request.headers });
			return new Response("refused in test", { status: 418 });
		});

		// When: the row is streamed inside a conversation.
		await opencodeGoProvider()
			.stream(nativeRow, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
				apiKey: "test-key",
				sessionId: "conversation-1",
			})
			.result();

		// Then: the request reached the documented native route and carried the routing header.
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.url.startsWith(`${DOCUMENTED_BASE}/v1/models/${nativeRow.id}:streamGenerateContent`)).toBe(true);
		expect(request?.headers.get("x-opencode-session")).toBe("conversation-1");
	});
});
