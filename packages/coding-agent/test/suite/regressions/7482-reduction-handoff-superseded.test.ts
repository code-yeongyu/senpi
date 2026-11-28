import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReductionHandoff } from "../../../src/core/extensions/builtin/compaction/context-reduction-handoff.ts";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7482 (omo#15026): an extension compaction that a newer compaction supersedes ended with a bare return, so its
// caller heard neither onComplete nor onError. The context-reduction handoff then stayed "in flight" forever and
// aborted every later turn that needed a handoff, which the sender saw as an empty aborted reply.

const summaries = () => Array.from({ length: 8 }, () => fauxAssistantMessage("<summary>Earlier work.</summary>"));

function seed(harness: Harness): void {
	const model = harness.getModel();
	for (let index = 0; index < 4; index++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `earlier request ${index} ${"context ".repeat(2_000)}` }],
			timestamp: index * 2,
		});
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `earlier answer ${index}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: index * 2 + 1,
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

type Ending = "complete" | "error";

async function setup() {
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	if (!api) throw new Error("extension api not captured");
	seed(harness);
	const live = harness.getExtensionRunner().createContext();
	const aborts: string[] = [];
	const endings: Ending[] = [];
	let ended = Promise.withResolvers<Ending>();
	const ctx: ExtensionContext = {
		...live,
		abort: (source) => {
			aborts.push(String(source));
			live.abort(source);
		},
		compact: (options?: CompactOptions) =>
			live.compact({
				...options,
				onComplete: (result) => {
					endings.push("complete");
					options?.onComplete?.(result);
					ended.resolve("complete");
				},
				onError: (error) => {
					endings.push("error");
					options?.onError?.(error);
					ended.resolve("error");
				},
			}),
	};
	const handoff = createReductionHandoff(api, "reduce");
	const nextEnding = () => {
		const current = ended.promise;
		return current.finally(() => {
			ended = Promise.withResolvers<Ending>();
		});
	};
	return { harness, ctx, handoff, aborts, endings, nextEnding };
}

describe("#7482 every terminal path of an extension compaction reports to its caller", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function expectHandoffRecovers(target: Awaited<ReturnType<typeof setup>>) {
		expect(target.handoff.isPending()).toBe(false);
		seed(target.harness);
		target.harness.setResponses(summaries());
		const next = target.nextEnding();
		target.handoff.request(target.ctx);
		expect(target.aborts).toEqual([]);
		await next;
		expect(target.handoff.isPending()).toBe(false);
	}

	it("completed: onComplete once", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses(summaries());

		const ending = target.nextEnding();
		target.handoff.request(target.ctx);

		expect(await ending).toBe("complete");
		expect(target.endings).toEqual(["complete"]);
		await expectHandoffRecovers(target);
	});

	it("failed: onError once when the summary request fails", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
		]);

		const ending = target.nextEnding();
		target.handoff.request(target.ctx);

		expect(await ending).toBe("error");
		expect(target.endings).toEqual(["error"]);
		await expectHandoffRecovers(target);
	});

	it("superseded: onError once when a newer compaction takes over before it runs", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses(summaries());

		const ending = target.nextEnding();
		target.handoff.request(target.ctx);
		await target.harness.session.compact();

		expect(await ending).toBe("error");
		expect(target.endings).toEqual(["error"]);
		await expectHandoffRecovers(target);
	});

	function nextExtensionError(target: Awaited<ReturnType<typeof setup>>) {
		const seen = Promise.withResolvers<{ event: string; error: string }>();
		const stop = target.harness.getExtensionRunner().onError((error) => seen.resolve(error));
		return seen.promise.finally(stop);
	}

	it("a throwing onComplete is reported as the caller's error: no onError, no failed compaction_end", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses(summaries());
		const reported = nextExtensionError(target);

		target.ctx.compact({
			onComplete: () => {
				throw new Error("onComplete consumer failed");
			},
		});

		expect(await reported).toMatchObject({ event: "compact", error: "onComplete consumer failed" });
		expect(target.endings).toEqual(["complete"]);
		const ends = target.harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
	});

	it("a throwing onError on a failed compaction is called once and reported, never again", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
		]);
		const reported = nextExtensionError(target);

		target.ctx.compact({
			onError: () => {
				throw new Error("onError consumer failed");
			},
		});

		expect(await reported).toMatchObject({ event: "compact", error: "onError consumer failed" });
		expect(target.endings).toEqual(["error"]);
		expect(target.harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("a throwing observer of the failed compaction_end still lets onError reach the caller and the admission go", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
		]);
		const stop = target.harness.session.subscribe((event) => {
			if (event.type !== "compaction_end" || event.errorMessage === undefined) return;
			stop();
			throw new Error("observer failed");
		});
		const reported = nextExtensionError(target);

		const ending = target.nextEnding();
		target.handoff.request(target.ctx);

		expect(await ending).toBe("error");
		expect(await reported).toMatchObject({ event: "compact", error: "observer failed" });
		expect(target.endings).toEqual(["error"]);
		await expectHandoffRecovers(target);
	});

	it("a throwing error listener on top of a throwing observer still lets onError reach the caller", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
		]);
		const stopObserver = target.harness.session.subscribe((event) => {
			if (event.type !== "compaction_end" || event.errorMessage === undefined) return;
			stopObserver();
			throw new Error("observer failed");
		});
		const stopListener = target.harness.getExtensionRunner().onError(() => {
			stopListener();
			throw new Error("error listener failed");
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		const ending = target.nextEnding();
		target.handoff.request(target.ctx);

		expect(await ending).toBe("error");
		expect(target.endings).toEqual(["error"]);
		expect(logged).toHaveBeenCalledTimes(1);
		logged.mockRestore();
		await expectHandoffRecovers(target);
	});

	it("cancelled: onError once when the compaction is cancelled", async () => {
		const target = await setup();
		harness = target.harness;
		target.harness.setResponses(summaries());

		const ending = target.nextEnding();
		target.handoff.request(target.ctx);
		target.harness.session.abortCompaction();

		expect(await ending).toBe("error");
		expect(target.endings).toEqual(["error"]);
		await expectHandoffRecovers(target);
	});
});
