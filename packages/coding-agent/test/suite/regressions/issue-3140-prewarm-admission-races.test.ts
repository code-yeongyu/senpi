import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptCachePrefixResult } from "../../../src/core/extensions/types.ts";
import { cleanupPrewarmHarnesses, createPrewarmHarness, deferred, within } from "../prompt-cache-prewarm-harness.ts";

describe("prewarm admission owns its one-shot opportunity (#3140)", () => {
	afterEach(() => {
		cleanupPrewarmHarnesses();
		vi.useRealTimers();
	});

	async function controlledPrefix() {
		vi.useFakeTimers();
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm);
		await harness.session.bindExtensions({});
		const ready = {
			status: "ready",
			request: {
				model: harness.getModel(),
				context: { systemPrompt: "fixture", messages: [] },
				options: {},
			},
		} satisfies PromptCachePrefixResult;
		const prefix = vi.fn(async (): Promise<PromptCachePrefixResult> => ready);
		const runner = harness.session.extensionRunner;
		const createContext = runner.createContext.bind(runner);
		// The provider prefix is an independent async boundary. Keep it ready even
		// after main-turn cancellation so this checks prewarm's own admission policy.
		vi.spyOn(runner, "createContext").mockImplementation((...args) => ({
			...createContext(...args),
			getPromptCachePrefixRequest: prefix,
		}));
		await runner.emit({ type: "session_start", reason: "reload" });
		return { harness, warm, prefix, ready };
	}

	it("does not warm a later draft after a real RPC prompt consumed the opportunity", async () => {
		const { harness, warm } = await controlledPrefix();
		harness.setResponses([fauxAssistantMessage("answer")]);

		await harness.session.prompt("hello", { source: "rpc" });
		harness.session.recordUserActivity("draft");
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("does not warm a later draft after an RPC steer is withdrawn from the queue", async () => {
		const { harness, warm } = await controlledPrefix();

		await harness.session.steer("hello", undefined, { source: "rpc" });
		const cleared = harness.session.clearQueue();
		expect(cleared.steering).toEqual(["hello"]);
		harness.session.recordUserActivity("draft");
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("rechecks prompt admission after a ready prefix is released", async () => {
		const { harness, warm, prefix, ready } = await controlledPrefix();
		const entered = deferred<void>();
		const release = deferred<PromptCachePrefixResult>();
		prefix.mockImplementation(async () => {
			entered.resolve();
			return release.promise;
		});
		harness.session.recordUserActivity("draft");
		await within(entered.promise, "detached prefix preparation");
		harness.setResponses([fauxAssistantMessage("answer")]);

		await harness.session.prompt("hello", { source: "rpc" });
		release.resolve(ready);
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("rechecks the enabled setting after prefix preparation", async () => {
		const { harness, warm, prefix, ready } = await controlledPrefix();
		const entered = deferred<void>();
		const release = deferred<PromptCachePrefixResult>();
		prefix.mockImplementation(async () => {
			entered.resolve();
			return release.promise;
		});
		harness.session.recordUserActivity("draft");
		await within(entered.promise, "detached prefix preparation");

		harness.settingsManager.applyOverrides({ promptCache: { keepAlive: { enabled: false } } });
		release.resolve(ready);
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("aborts an in-flight old-model warm when the model changes", async () => {
		const pendingWarm = deferred<{ supported: false }>();
		const { harness, warmCalled } = await createPrewarmHarness(() => pendingWarm.promise, {
			models: [{ id: "before" }, { id: "after" }],
		});
		await harness.session.bindExtensions({});
		harness.session.recordUserActivity("draft");
		const call = await within(warmCalled, "old-model warm");
		const next = harness.getModel("after");
		if (next === undefined) throw new Error("Missing fixture model");

		try {
			await harness.session.setModel(next);

			expect(call.model.id).toBe("before");
			expect(harness.session.model?.id).toBe("after");
			expect(call.options?.signal?.aborted).toBe(true);
		} finally {
			pendingWarm.resolve({ supported: false });
		}
	});
});
