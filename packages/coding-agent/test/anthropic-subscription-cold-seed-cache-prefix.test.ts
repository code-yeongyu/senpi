import type { AssistantMessage, Context, ImageContent, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	MAX_REPLAYED_HISTORY_IMAGES,
	REPLAYED_UPLOAD_DROP_STEP,
} from "../src/core/extensions/builtin/anthropic-subscription/cold-seed-images.ts";
import { buildPromptBlocks } from "../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import type { ContentBlockParam } from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	breakpointIndex,
	type CacheUsage,
	firstDivergence,
	PromptCacheSimulator,
} from "./helpers/prompt-cache-simulator.ts";

function screenshot(n: number): ImageContent {
	return { type: "image", mimeType: "image/png", data: Buffer.from(`synthetic screenshot ${n}`).toString("base64") };
}

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

function earlierTurns(count: number): Message[] {
	return Array.from({ length: count }, (_, n): Message[] => [
		{ role: "user", content: `question ${n}: ${"context ".repeat(250)}`, timestamp: n * 2 },
		assistant([{ type: "text", text: `answer ${n}: ${"detail ".repeat(250)}` }], n * 2 + 1),
	]).flat();
}

function screenshotCall(id: string, image: ImageContent, timestamp: number): Message[] {
	return [
		assistant([{ type: "toolCall", id, name: "read", arguments: { path: `${id}.png` } }], timestamp),
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [image], isError: false, timestamp },
	];
}

/**
 * The #5275 sequence with resume off: every request of an image-heavy tool turn is a rebuilt one-shot prompt, then the
 * turn ends and a user-role message (a background completion) starts the next request.
 */
function imageToolTurn(options: { readonly screenshots: number; readonly userUpload: boolean }): {
	readonly inTurn: Message[][];
	readonly afterClosure: Message[];
} {
	const history = earlierTurns(12);
	const ask: Message = {
		role: "user",
		content: options.userUpload
			? [{ type: "text", text: "Run the UI QA against this mockup" }, screenshot(0)]
			: "Run the UI QA",
		timestamp: 100,
	};
	const inTurn: Message[][] = [[...history, ask]];
	let transcript: Message[] = [...history, ask];
	for (let n = 1; n <= options.screenshots; n++) {
		transcript = [...transcript, ...screenshotCall(`shot-${n}`, screenshot(n), 100 + n)];
		inTurn.push(transcript);
	}
	const closed: Message[] = [
		...transcript,
		assistant([{ type: "text", text: "QA done: every screen matches." }], 200),
		{ role: "user", content: "Background task finished: build succeeded.", timestamp: 201 },
	];
	return { inTurn, afterClosure: closed };
}

function rebuild(messages: Message[]): ContentBlockParam[] {
	return buildPromptBlocks({ messages } satisfies Context, undefined, undefined, { cacheBreakpoint: "1h" });
}

function measure(turn: ReturnType<typeof imageToolTurn>): {
	readonly last: ContentBlockParam[];
	readonly next: ContentBlockParam[];
	readonly usage: CacheUsage;
} {
	const cache = new PromptCacheSimulator();
	const requests = turn.inTurn.map(rebuild);
	for (const request of requests) cache.request(request);
	const next = rebuild(turn.afterClosure);
	return { last: requests.at(-1) as ContentBlockParam[], next, usage: cache.request(next) };
}

describe("anthropic-subscription cold seed keeps the cached history across turn closure (senpi#5275)", () => {
	it("a turn that ends after tool screenshots rewrites none of the history the last request cached", () => {
		const { last, next, usage } = measure(imageToolTurn({ screenshots: 5, userUpload: false }));

		expect(firstDivergence(last, next)).toBeGreaterThan(breakpointIndex(last));
		expect(usage.cacheRead).toBeGreaterThan(usage.cacheWrite * 10);
	});

	it("past the replay cap, new uploads rewrite the cached history once per drop step, not on every upload (senpi#2988)", () => {
		const requests: ContentBlockParam[][] = [];
		let transcript: Message[] = earlierTurns(2);
		for (let n = 1; n <= MAX_REPLAYED_HISTORY_IMAGES * 2; n++) {
			transcript = [
				...transcript,
				{ role: "user", content: [{ type: "text", text: `screen ${n}` }, screenshot(n)], timestamp: 100 + n * 2 },
			];
			requests.push(rebuild(transcript));
			transcript = [...transcript, assistant([{ type: "text", text: `noted ${n}` }], 101 + n * 2)];
		}

		const rewrites = requests.slice(1).filter((request, n) => {
			const previous = requests[n] as ContentBlockParam[];
			return firstDivergence(previous, request) <= breakpointIndex(previous);
		});

		expect(rewrites).toHaveLength(MAX_REPLAYED_HISTORY_IMAGES / REPLAYED_UPLOAD_DROP_STEP);
	});

	it("a turn the user opened with an upload keeps that upload's history bytes when it closes", () => {
		const { last, next, usage } = measure(imageToolTurn({ screenshots: 1, userUpload: true }));

		expect(firstDivergence(last, next)).toBeGreaterThan(breakpointIndex(last));
		expect(usage.cacheRead).toBeGreaterThan(usage.cacheWrite * 10);
	});
});
