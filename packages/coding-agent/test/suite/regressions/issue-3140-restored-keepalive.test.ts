import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCacheKeepAliveExtension } from "../../../src/core/extensions/builtin/cache-keepalive/index.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;

describe("restored Anthropic keep-alive admission (#3140)", () => {
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each(["startup", "resume", "fork", "reload"] as const)(
		"waits for first activity after %s even with recent cached history",
		async (reason) => {
			vi.useFakeTimers();
			const warm = vi.fn(async () => ({ supported: false as const }));
			const h = await createHarness({
				api: "anthropic-messages",
				models: [{ id: "restored" }],
				settings: { promptCache: { keepAlive: { enabled: true, maxRequestsPerSession: 1 } } },
				extensionFactories: [
					createCacheKeepAliveExtension({ warmPromptCache: warm, isPromptCachePrewarmModel: () => false }),
				],
			});
			harness = h;
			h.agent.sessionId = h.sessionManager.getSessionId();
			h.agent.state.model = { ...h.getModel(), baseUrl: "https://api.anthropic.com" };
			const assistant = fauxAssistantMessage("cached response");
			const cached = {
				...assistant,
				api: "anthropic-messages" as const,
				model: h.getModel().id,
				provider: h.getModel().provider,
				timestamp: Date.now(),
				usage: { ...assistant.usage, cacheRead: 45_000 },
			};
			h.sessionManager.appendMessage(cached);
			h.agent.state.messages = [cached];
			const runner = h.getExtensionRunner();
			const createContext = runner.createContext.bind(runner);
			vi.spyOn(runner, "createContext").mockImplementation((...args) => ({
				...createContext(...args),
				getPromptCacheSafeWaitSeconds: () => 300,
			}));
			await h.session.bindExtensions({});
			if (reason !== "startup") await runner.emit({ type: "session_start", reason });
			await vi.advanceTimersByTimeAsync(300_000);

			expect(warm).not.toHaveBeenCalled();

			h.session.recordUserActivity("draft");
			await vi.advanceTimersByTimeAsync(0);
			expect(warm).toHaveBeenCalledTimes(1);
		},
	);
});
