import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicWebSearchExtension from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.unstubAllGlobals();
});

describe("native search failure in a real AgentSession", () => {
	it("continues the original request once and executes one standalone search after native rejection", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ results: [{ title: "Docs", url: "https://example.com/docs", text: "Official docs" }] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		harness = await createHarness({
			api: "anthropic-messages",
			provider: "server-search-test",
			settings: { retry: { enabled: false } },
			extensionFactories: [anthropicWebSearchExtension, websearchExtension],
		});
		const h = harness;
		h.agent.state.model = {
			...h.agent.state.model,
			compat: { supportsWebSearch: true },
		} as Model<Api>;
		await mkdir(join(h.tempDir, ".pi"));
		await writeFile(
			join(h.tempDir, ".pi", "websearch.json"),
			JSON.stringify({ auto: false, providers: [{ provider: "exa", apiKey: "test-key" }] }),
		);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 web_search_20250305 unsupported" }),
			fauxAssistantMessage(fauxToolCall("web_search", { query: "official documentation" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("FALLBACK_DONE"),
		]);
		let unsubscribe = () => {};
		const settled = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error("Fallback did not settle"));
			}, 5000);
			unsubscribe = h.session.subscribe((event) => {
				if (event.type !== "agent_settled" || h.faux.state.callCount !== 3) return;
				clearTimeout(timeout);
				unsubscribe();
				resolve();
			});
		});
		await h.session.prompt("Find the official documentation.");
		await settled;
		expect(h.faux.state.callCount).toBe(3);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "websearch-native-fallback"),
		).toHaveLength(1);
		const final = h.session.messages.at(-1);
		expect(final?.role).toBe("assistant");
		expect(final && "content" in final ? final.content : undefined).toEqual([
			{ type: "text", text: "FALLBACK_DONE" },
		]);
	});
});
