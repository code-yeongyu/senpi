import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { TOOL_RESULT_PLACEHOLDER } from "../../../src/core/extensions/builtin/compaction/repair-tool-pairs.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionAPI, ExtensionError } from "../../../src/core/extensions/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const PROSE = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
const FILLER_CHARS = 30_000;
const FILLER_USERS = 24;
const TINY_WINDOW_SETTINGS = {
	compaction: { enabled: false, speculativeEnabled: false, idleCompactionEnabled: false },
};

function prose(chars: number): string {
	return PROSE.repeat(Math.ceil(chars / PROSE.length)).slice(0, chars);
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	Object.freeze(value);
	for (const nested of Object.values(value)) deepFreeze(nested, seen);
}

interface SeededTranscript {
	anchor: AgentMessage;
}

// A ~195k-token transcript on a 400k-window model whose output reserve halves
// the prompt window: every session-level compaction gate (hard limit, proactive,
// speculative) stands down, while the context pipeline's emergency prune engages
// past 95% of the 200k prompt window. Every seeded string stays under the
// resident-store tokenization floor so idle externalization is a no-op.
function seedTranscript(harness: Harness): SeededTranscript {
	const base = 1_700_000_000_000;
	for (let index = 0; index < FILLER_USERS; index += 1) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: prose(FILLER_CHARS) }],
			timestamp: base + index,
		});
	}
	let timestamp = base + FILLER_USERS;
	const nextTimestamp = () => (timestamp += 1);
	const dangling = fauxAssistantMessage(
		[fauxToolCall("read", { path: "/src/dangling.ts" }, { id: "call-dangling" })],
		{
			stopReason: "toolUse",
			timestamp: nextTimestamp(),
		},
	);
	const orphanResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-nonexistent",
		toolName: "read",
		content: [{ type: "text", text: prose(FILLER_CHARS) }],
		isError: false,
		timestamp: nextTimestamp(),
	};
	const bigCall = fauxAssistantMessage([fauxToolCall("read", { path: "/src/big.ts" }, { id: "call-big" })], {
		stopReason: "toolUse",
		timestamp: nextTimestamp(),
	});
	const bigResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-big",
		toolName: "read",
		content: [{ type: "text", text: prose(FILLER_CHARS) }],
		isError: false,
		timestamp: nextTimestamp(),
	};
	const anchorMessage = fauxAssistantMessage(prose(200), { stopReason: "stop", timestamp: nextTimestamp() });
	const tail = [dangling, orphanResult, bigCall, bigResult, anchorMessage];
	for (const message of tail) harness.sessionManager.appendMessage(message);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const anchor = harness.session.agent.state.messages.at(-1);
	if (!anchor) throw new Error("seeded transcript is empty");
	return { anchor };
}

function respondOk(harness: Harness): void {
	const model = harness.getModel();
	harness.setResponses([
		Object.assign(fauxAssistantMessage("ok"), { api: model.api, provider: model.provider, model: model.id }),
	]);
}

describe("issue #2525: context hooks share an uncloned transcript with declared handlers", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs the builtin pipeline on frozen transcript objects without cloning or mutating them", async () => {
		// Given a deep-frozen seeded transcript and only mutation-free declared handlers
		const capturedMessages: AgentMessage[][] = [];
		const captureExtension = (pi: ExtensionAPI) => {
			pi.on(
				"context",
				(event) => {
					capturedMessages.push(event.messages);
				},
				{ mutatesMessages: false },
			);
		};
		const harness = await createHarness({
			models: [{ id: "wide-window", contextWindow: 400_000, maxTokens: 200_000 }],
			settings: TINY_WINDOW_SETTINGS,
			extensionFactories: [
				{ name: "compaction", factory: compactionExtension },
				{ name: "tool-search", factory: toolSearchExtension },
				{ name: "capture", factory: captureExtension },
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const extensionErrors: ExtensionError[] = [];
		harness.getExtensionRunner().onError((error) => extensionErrors.push(error));
		const { anchor } = seedTranscript(harness);
		const seeded = [...harness.session.agent.state.messages];
		const snapshotsBefore = seeded.map((message) => JSON.stringify(message));
		for (const message of seeded) deepFreeze(message);
		respondOk(harness);

		// When a real turn runs the request through the context hooks
		await harness.session.prompt("hello");

		// Then the untouched anchor reached the post-pipeline list by reference: no clone
		expect(capturedMessages.length).toBeGreaterThan(0);
		expect(capturedMessages[0]?.includes(anchor)).toBe(true);
		// And no handler mutated a frozen transcript object (a mutation throws or
		// shows in the snapshot, whichever the runtime's strictness allows)
		expect(extensionErrors).toEqual([]);
		expect(
			harness.session.agent.state.messages.slice(0, snapshotsBefore.length).map((m) => JSON.stringify(m)),
		).toEqual(snapshotsBefore);
		// And the pipeline did its real work on the frozen input
		const delivered = capturedMessages[0] ?? [];
		expect(delivered.some((message) => message.role === "toolResult" && message.toolCallId === "call-dangling")).toBe(
			true,
		);
		const orphan = delivered.find(
			(message) => message.role === "toolResult" && message.toolCallId === "call-nonexistent",
		);
		expect(
			orphan && "content" in orphan && Array.isArray(orphan.content) ? orphan.content[0] : undefined,
		).toMatchObject({ type: "text", text: TOOL_RESULT_PLACEHOLDER });
		const big = delivered.find((message) => message.role === "toolResult" && message.toolCallId === "call-big");
		const bigText =
			big && "content" in big && Array.isArray(big.content) && big.content[0]?.type === "text"
				? big.content[0].text
				: "";
		expect(bigText.length).toBeLessThan(FILLER_CHARS);
		expect(getAssistantTexts(harness)).toContain("ok");
	});

	it("keeps cloning when any context handler has not declared mutatesMessages", async () => {
		// Given the same pipeline plus one undeclared third-party-style handler
		const capturedMessages: AgentMessage[][] = [];
		const captureExtension = (pi: ExtensionAPI) => {
			pi.on("context", (event) => {
				capturedMessages.push(event.messages);
			});
		};
		const harness = await createHarness({
			models: [{ id: "wide-window", contextWindow: 400_000, maxTokens: 200_000 }],
			settings: TINY_WINDOW_SETTINGS,
			extensionFactories: [
				{ name: "compaction", factory: compactionExtension },
				{ name: "tool-search", factory: toolSearchExtension },
				{ name: "capture", factory: captureExtension },
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { anchor } = seedTranscript(harness);
		respondOk(harness);

		// When the turn runs
		await harness.session.prompt("hello");

		// Then handlers worked on clones: the transcript object never left the runtime
		expect(capturedMessages.length).toBeGreaterThan(0);
		expect(capturedMessages[0]?.includes(anchor)).toBe(false);
		expect(getAssistantTexts(harness)).toContain("ok");
	});

	it("does not let a handler registered mid-pass see the live transcript (review H1)", async () => {
		// Given only declared handlers at the start of the pass, one of which registers an undeclared
		// context_with_system handler while it runs
		let registered = false;
		const lateExtension = (pi: ExtensionAPI) => {
			pi.on(
				"context",
				() => {
					if (registered) return;
					registered = true;
					pi.on("context_with_system", (event) => {
						for (const message of event.messages) {
							if (
								message.role === "user" &&
								Array.isArray(message.content) &&
								message.content[0]?.type === "text"
							) {
								message.content[0].text = "MUTATED BY UNDECLARED HANDLER";
							}
						}
					});
				},
				{ mutatesMessages: false },
			);
		};
		const harness = await createHarness({
			settings: TINY_WINDOW_SETTINGS,
			extensionFactories: [{ name: "late", factory: lateExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		respondOk(harness);

		// When the first request runs (the late handler joins mid-pass) and a second request follows
		await harness.session.prompt("first");
		respondOk(harness);
		await harness.session.prompt("second");

		// Then the transcript the session keeps was never edited: the late handler ran on a clone
		// (it joined the second pass, which then cloned because it is undeclared)
		const userTexts = harness.session.agent.state.messages
			.filter((message) => message.role === "user")
			.map((message) =>
				Array.isArray(message.content) && message.content[0]?.type === "text"
					? message.content[0].text
					: message.content,
			);
		expect(userTexts).not.toContain("MUTATED BY UNDECLARED HANDLER");
		expect(registered).toBe(true);
	});
});
