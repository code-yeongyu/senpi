import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupPrewarmHarnesses, createPrewarmHarness, within } from "../prompt-cache-prewarm-harness.ts";

describe("prewarm waits for user activity (#3140)", () => {
	afterEach(() => {
		cleanupPrewarmHarnesses();
		vi.useRealTimers();
	});

	it.each(["startup", "resume", "fork", "reload"] as const)(
		"makes zero provider calls on %s without input",
		async (reason) => {
			vi.useFakeTimers();
			const warm = vi.fn(async () => ({ supported: false as const }));
			const { harness } = await createPrewarmHarness(warm);
			const provider = vi.spyOn(harness.agent, "streamFunction");

			await harness.session.bindExtensions({});
			if (reason !== "startup") {
				await harness.session.extensionRunner.emit({ type: "session_start", reason });
			}
			await vi.runAllTimersAsync();

			expect(warm).not.toHaveBeenCalled();
			expect(provider).not.toHaveBeenCalled();
		},
	);

	it("sends an RPC prompt once without an additional prewarm", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm);
		const provider = vi.spyOn(harness.agent, "streamFunction");
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.bindExtensions({});
		await vi.runAllTimersAsync();

		await harness.session.prompt("hello", { source: "rpc" });

		expect(provider).toHaveBeenCalledTimes(1);
		expect(warm).not.toHaveBeenCalled();
	});

	it("never prewarms with keep-alive disabled", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm, {
			settings: { promptCache: { keepAlive: { enabled: false } } },
		});
		await harness.session.bindExtensions({});

		harness.session.recordUserActivity("draft");
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("targets a model selected before the first activity", async () => {
		const { harness, warmCalled } = await createPrewarmHarness(async () => ({ supported: false }), {
			models: [{ id: "before" }, { id: "after" }],
		});
		await harness.session.bindExtensions({});
		const nextModel = harness.getModel("after");
		if (nextModel === undefined) throw new Error("Missing fixture model");

		await harness.session.setModel(nextModel);
		harness.session.recordUserActivity("draft");
		const call = await within(warmCalled, "retargeted prewarm");

		expect(call.model.id).toBe("after");
	});

	it("consumes prewarm when the first activity is an RPC steer", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm);
		await harness.session.bindExtensions({});

		await harness.session.steer("hello", undefined, { source: "rpc" });
		harness.session.recordUserActivity("draft");
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("arms a fresh opportunity on a new generation without firing at restart", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness, warmCalled } = await createPrewarmHarness(warm);
		await harness.session.bindExtensions({});
		harness.session.recordUserActivity("draft");
		await within(warmCalled, "initial prewarm");
		await vi.runAllTimersAsync();

		await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		await vi.runAllTimersAsync();
		expect(warm).toHaveBeenCalledTimes(1);
		harness.session.recordUserActivity("draft");
		await vi.runAllTimersAsync();

		expect(warm).toHaveBeenCalledTimes(2);
	});
});
