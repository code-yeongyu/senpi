import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompaction } from "../../../src/core/compaction/index.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createBlockingContext, createCompactionHandlers } from "../../helpers/blocking-compaction-harness.ts";
import { CODEX_MODEL, codexToken } from "./issue-2434-remote-compaction-support.ts";

// senpi#2434: a remote compaction that runs out of its budget must never fail
// silently: the user is told what happened and what happens next, and the local
// fallback still runs exactly as before.

afterEach(() => {
	vi.useRealTimers();
});

function hungRemoteThenLocalSummaryRuntime(ctx: ExtensionContext) {
	const remoteCalls: SimpleStreamOptions[] = [];
	let localCalls = 0;
	const runtime = {
		streamSimple: (model: Model<Api>, _context: unknown, options: SimpleStreamOptions) => {
			remoteCalls.push(options);
			return {
				result: async () => {
					await options.onPayload?.({ model: model.id, input: [] }, model);
					return new Promise<AssistantMessage>((_resolve, reject) => {
						options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
							once: true,
						});
					});
				},
			};
		},
		stream: () => {
			localCalls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = fauxAssistantMessage("Local summary of the old context.");
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	};
	(ctx.modelRegistry as unknown as { modelRuntime: typeof runtime }).modelRuntime = runtime;
	(ctx.modelRegistry as unknown as { getApiKeyAndHeaders: () => Promise<unknown> }).getApiKeyAndHeaders =
		async () => ({ ok: true as const, apiKey: codexToken() });
	return { remoteCalls, localCalls: () => localCalls };
}

describe("issue #2434: a remote compaction timeout is reported to the user", () => {
	it("tells the user it timed out, after how long and at what size, then runs the local summary as before", async () => {
		vi.useFakeTimers();
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900, model: CODEX_MODEL });
		const notify = vi.fn();
		const updateCompaction = vi.fn();
		Object.assign(harness.ctx, { ui: { notify }, updateCompaction });
		const runtime = hungRemoteThenLocalSummaryRuntime(harness.ctx);
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		if (!preparation) throw new Error("Expected a compaction preparation");
		const signal = new AbortController().signal;

		const startedAt = Date.now();
		const pending = handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				requestId: "issue-2434-notice",
				preparation: { ...preparation, tokensBefore: 164_387 },
				branchEntries,
				signal,
			},
			harness.ctx,
		);
		await vi.advanceTimersToNextTimerAsync();
		const waitedMs = Date.now() - startedAt;
		const result = await pending;

		// The remote request was made once and abandoned at its budget.
		expect(runtime.remoteCalls).toHaveLength(1);
		expect(runtime.remoteCalls[0]?.signal?.aborted).toBe(true);

		// The TUI notice says what happened and what happens next.
		const warnings = notify.mock.calls.filter((call) => call[1] === "warning").map((call) => String(call[0]));
		expect(warnings).toHaveLength(1);
		const notice = warnings[0] ?? "";
		expect(notice).toMatch(/remote compaction timed out/i);
		expect(notice).toContain(`${Math.round(waitedMs / 1000)}s`);
		expect(notice).toContain("164,387 tokens");
		expect(notice).toMatch(/local summary/i);

		// The compaction status event the desktop reads carries the same notice.
		expect(updateCompaction).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "threshold", signal, text: notice }),
		);

		// The fallback is unchanged: the local summary runs and becomes the compaction.
		expect(runtime.localCalls()).toBe(1);
		expect(result).not.toHaveProperty("cancel");
		expect(result?.compaction?.summary).toContain("Local summary of the old context.");
	});
});
