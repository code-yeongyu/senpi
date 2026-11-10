import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#6345: an extension-triggered compaction aborts the active run, which settles, then resumes the queued
// messages. This rig stops in the middle of that resumed continuation, with its provider request held open.

export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export async function expectWithin(promise: Promise<unknown>, timeoutMs: number, what: string): Promise<void> {
	expect(await settlesWithin(promise, timeoutMs), what).toBe(true);
}

/** A provider response that stays in flight until released or aborted, and reports when it was requested. */
export function heldResponse(text: string) {
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let calls = 0;
	const step: FauxResponseFactory = (_context, options) => {
		calls += 1;
		requested.resolve();
		return new Promise<AssistantMessage>((resolve) => {
			const done = () => resolve(fauxAssistantMessage(text));
			if (options?.signal?.aborted) return done();
			options?.signal?.addEventListener("abort", done, { once: true });
			void release.promise.then(done);
		});
	};
	return { step, requested: requested.promise, release: () => release.resolve(), calls: () => calls };
}

export interface ContinuationRig {
	readonly harness: Harness;
	readonly pi: ExtensionAPI;
	readonly continuation: ReturnType<typeof heldResponse>;
	/** `isStreaming` sampled at every session event of the resumed continuation. */
	readonly samples: boolean[];
	readonly continuationEnded: Promise<void>;
	/** The prompt the compaction aborted; it settles with the work it handed over. */
	readonly activePrompt: Promise<void>;
}

/** Runs a prompt, lets the real ctx.compact() binding abort it with a message queued, and returns once the resumed continuation's provider request is in flight. */
export async function startPostCompactionContinuation(harnesses: Harness[]): Promise<ContinuationRig> {
	let pi: ExtensionAPI | undefined;
	let ctx: ExtensionContext | undefined;
	const harness = await createHarness({
		settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		extensionFactories: [
			(api) => {
				pi = api;
				api.on("session_start", (_event, extensionCtx) => {
					ctx = extensionCtx;
				});
				api.on("session_before_compact", (event) => ({
					compaction: {
						summary: "extension compaction during an active run",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	if (!pi || !ctx) throw new Error("Expected the extension API and its session_start context");

	const active = heldResponse("active response");
	const continuation = heldResponse("continuation response");
	harness.setResponses([
		fauxAssistantMessage("first seed response"),
		fauxAssistantMessage("second seed response"),
		active.step,
		continuation.step,
	]);
	await harness.session.prompt("first seed prompt");
	await harness.session.prompt("second seed prompt");

	const samples: boolean[] = [];
	const continuationEnded = Promise.withResolvers<void>();
	let compacted = false;
	let inContinuation = false;
	harness.session.subscribe((event) => {
		if (event.type === "compaction_end" && event.reason === "extension") compacted = true;
		if (compacted && event.type === "agent_start") inContinuation = true;
		if (inContinuation) samples.push(harness.session.isStreaming);
		if (inContinuation && event.type === "agent_end") {
			inContinuation = false;
			continuationEnded.resolve();
		}
	});

	const activePrompt = harness.session.prompt("prompt whose provider request is active");
	await active.requested;
	expect(harness.session.isStreaming).toBe(true);
	// A message queued when the handoff fires (a detached-eval notification, a monitor event) is what the
	// compaction resumes.
	pi.sendMessage(
		{ customType: "queued-note", content: "notification queued during the handoff", display: false },
		{ deliverAs: "steer" },
	);
	// The real ctx.compact() binding, as the built-in context-reduction handoff calls it.
	ctx.compact();
	await expectWithin(continuation.requested, 2_000, "the compaction resumes the queued message");
	return { harness, pi, continuation, samples, continuationEnded: continuationEnded.promise, activePrompt };
}
