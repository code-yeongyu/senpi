import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPromptBlocks } from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import { dedupeUltraworkBlocks } from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-directive-dedupe.ts";
import type { ContentBlockParam } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	loadAnthropicSubscriptionProviderSettings,
	resumeModeSource,
} from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import { ContinuityNoticeTracker } from "../../../src/modes/interactive/components/continuity-notice.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const DIRECTIVE = "<ultrawork-mode>work until done</ultrawork-mode>";

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
		stopReason: "toolUse",
		timestamp,
	};
}

function toolLoop(rounds: number, firstPrompt = `${DIRECTIVE} fix the bug`): Message[] {
	const messages: Message[] = [{ role: "user", content: firstPrompt, timestamp: 1 }];
	for (let round = 1; round <= rounds; round++) {
		messages.push(
			assistant(
				[{ type: "toolCall", id: `call-${round}`, name: "read", arguments: { path: `f${round}.ts` } }],
				round,
			),
		);
		messages.push({
			role: "toolResult",
			toolCallId: `call-${round}`,
			toolName: "read",
			content: [{ type: "text", text: `contents of f${round}.ts` }],
			isError: false,
			timestamp: round,
		});
	}
	return messages;
}

function rebuilt(messages: Message[]): ContentBlockParam[] {
	const context: Context = { messages };
	return dedupeUltraworkBlocks(buildPromptBlocks(context, undefined, undefined, { cacheBreakpoint: "1h" })).blocks;
}

function withoutBreakpoint(block: ContentBlockParam): unknown {
	const { cache_control: _cacheControl, ...rest } = block as ContentBlockParam & { cache_control?: unknown };
	return rest;
}

function breakpointIndexes(blocks: readonly ContentBlockParam[]): number[] {
	return blocks.flatMap((block, index) => ("cache_control" in block && block.cache_control ? [index] : []));
}

function expectCacheablePrefix(previous: ContentBlockParam[], next: ContentBlockParam[]): void {
	const [previousBreakpoint] = breakpointIndexes(previous);
	const [nextBreakpoint] = breakpointIndexes(next);
	expect(breakpointIndexes(previous)).toHaveLength(1);
	expect(breakpointIndexes(next)).toHaveLength(1);
	if (previousBreakpoint === undefined || nextBreakpoint === undefined) throw new Error("no cache breakpoint");
	expect(next.slice(0, previousBreakpoint + 1).map(withoutBreakpoint)).toEqual(
		previous.slice(0, previousBreakpoint + 1).map(withoutBreakpoint),
	);
	// The API looks for an earlier cache entry within about 20 blocks of the new breakpoint.
	expect(nextBreakpoint - previousBreakpoint).toBeLessThanOrEqual(20);
}

describe("senpi#2982 a rebuilt Anthropic Subscription prompt is append-only up to its cache breakpoint", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps each turn's history as a byte prefix of the next turn through the breakpoint", () => {
		// given a tool loop rebuilt from scratch every turn, as with resumeMode off
		// when four consecutive turns are rebuilt
		const turns = [1, 2, 3, 4].map((rounds) => rebuilt(toolLoop(rounds)));

		// then each turn's history, up to its breakpoint, is repeated unchanged by the next turn
		for (let turn = 1; turn < turns.length; turn++) {
			expectCacheablePrefix(turns[turn - 1] as ContentBlockParam[], turns[turn] as ContentBlockParam[]);
		}
	});

	it("puts the breakpoint on the last history block, before the per-turn tail", () => {
		// when a turn is rebuilt
		const blocks = rebuilt(toolLoop(2));
		const [breakpoint] = breakpointIndexes(blocks);

		// then the history closer, the instruction and the current message come after it
		expect(blocks[(breakpoint ?? -2) + 1]).toEqual({ type: "text", text: "\n</conversation_history>" });
	});

	it("does not rewrite an earlier directive when a new ultrawork prompt arrives", () => {
		// given a turn whose history carries the directive once
		const before = toolLoop(2);
		const previous = rebuilt(before);

		// when the user sends another ultrawork prompt and the conversation is rebuilt
		const after: Message[] = [
			...before,
			assistant([{ type: "text", text: "done with f2" }], 10),
			{ role: "user", content: `${DIRECTIVE} now the tests`, timestamp: 11 },
			assistant([{ type: "toolCall", id: "call-9", name: "read", arguments: { path: "t.ts" } }], 12),
			{
				role: "toolResult",
				toolCallId: "call-9",
				toolName: "read",
				content: [{ type: "text", text: "test contents" }],
				isError: false,
				timestamp: 13,
			},
		];
		const next = rebuilt(after);

		// then the earlier directive is kept and only the later identical copy is collapsed
		expectCacheablePrefix(previous, next);
		const history = next.slice(0, (breakpointIndexes(next)[0] ?? 0) + 1);
		const text = history.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text.split(DIRECTIVE)).toHaveLength(2);
		expect(text).toContain("[ultrawork directive repeated");
	});

	it("keeps a changed directive as new content after the earlier one, without rewriting it", () => {
		// given a turn whose history carries the first directive
		const before = toolLoop(2);
		const previous = rebuilt(before);
		const updated = "<ultrawork-mode>work until done, and run the tests first</ultrawork-mode>";

		// when the user sends a directive with different text and the conversation is rebuilt
		const after: Message[] = [
			...before,
			assistant([{ type: "text", text: "done with f2" }], 10),
			{ role: "user", content: `${updated} now the tests`, timestamp: 11 },
			assistant([{ type: "toolCall", id: "call-9", name: "read", arguments: { path: "t.ts" } }], 12),
			{
				role: "toolResult",
				toolCallId: "call-9",
				toolName: "read",
				content: [{ type: "text", text: "test contents" }],
				isError: false,
				timestamp: 13,
			},
		];
		const next = rebuilt(after);

		// then the earlier history is unchanged, both directives are present, and the newer one comes later
		expectCacheablePrefix(previous, next);
		const history = next
			.slice(0, (breakpointIndexes(next)[0] ?? 0) + 1)
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		expect(history.indexOf(DIRECTIVE)).toBeGreaterThanOrEqual(0);
		expect(history.indexOf(updated)).toBeGreaterThan(history.indexOf(DIRECTIVE));
		expect(history).not.toContain("[ultrawork directive repeated");
	});

	it("keeps every copy of an A, B, A directive sequence, so the latest wording is the one just above", () => {
		// given directive A, then a different directive B, then A again in history
		const directiveB = "<ultrawork-mode>review before merging</ultrawork-mode>";
		const messages: Message[] = [
			{ role: "user", content: `${DIRECTIVE} one`, timestamp: 1 },
			assistant([{ type: "text", text: "ok" }], 2),
			{ role: "user", content: `${directiveB} two`, timestamp: 3 },
			assistant([{ type: "text", text: "ok" }], 4),
			{ role: "user", content: `${DIRECTIVE} three`, timestamp: 5 },
			assistant([{ type: "text", text: "ok" }], 6),
			{ role: "user", content: "current", timestamp: 7 },
		];

		// when the turn is rebuilt
		const history = rebuilt(messages)
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");

		// then nothing collapses, because no directive repeats the one just before it
		expect(history.split(DIRECTIVE)).toHaveLength(3);
		expect(history).toContain(directiveB);
		expect(history).not.toContain("[ultrawork directive repeated");
	});

	it("keeps the directive of the current message in full", () => {
		// given an earlier ultrawork prompt in history and a new one as the current message
		const messages: Message[] = [
			...toolLoop(1),
			assistant([{ type: "text", text: "ok" }], 5),
			{ role: "user", content: `${DIRECTIVE} continue`, timestamp: 6 },
		];

		// when the turn is rebuilt
		const blocks = rebuilt(messages);
		const tail = blocks.slice((breakpointIndexes(blocks)[0] ?? 0) + 1);

		// then the current message still carries the full directive
		expect(tail.some((block) => block.type === "text" && block.text.includes(DIRECTIVE))).toBe(true);
	});

	it("names where resumeMode off was set, once, and stays quiet for a request with no session", () => {
		// given the continuity diagnostics of two turns with resume off from the environment, and one with no session
		const notice = (details: Record<string, unknown>) =>
			({
				...assistant([{ type: "text", text: "ok" }], 1),
				diagnostics: [{ type: "claude_sdk_oauth_session_continuity", timestamp: 1, details }],
			}) as AssistantMessage;
		const tracker = new ContinuityNoticeTracker();

		// when the transcript renders them
		const first = tracker.noticeFor(notice({ kind: "disabled", reason: "resume_mode_off", settingSource: "env" }));
		const second = tracker.noticeFor(notice({ kind: "disabled", reason: "resume_mode_off", settingSource: "env" }));
		const sessionless = new ContinuityNoticeTracker().noticeFor(
			notice({ kind: "disabled", reason: "registry_miss" }),
		);

		// then the first names the environment variable, and the others render nothing
		expect(first).toContain("set by SENPI_CLAUDE_SDK_OAUTH_RESUME");
		expect(second).toBeUndefined();
		expect(sessionless).toBeUndefined();
	});

	it.each([
		["the environment", {}, {}, { SENPI_CLAUDE_SDK_OAUTH_RESUME: "off" }, "env"],
		["project settings", { resumeMode: "auto" }, { resumeMode: "off" }, {}, "project"],
		["global settings", { resumeMode: "off" }, {}, {}, "global"],
	] as const)("records that resumeMode came from %s", (_label, global, project, environment, expected) => {
		// given resumeMode set in one layer
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ claudeSdkOauthProvider: global }));
		storage.withLock("project", () => JSON.stringify({ claudeSdkOauthProvider: project }));

		// when the provider settings load
		const settings = loadAnthropicSubscriptionProviderSettings(SettingsManager.fromStorage(storage), environment);

		// then the source of the value is known
		expect(settings.resumeMode).toBe("off");
		expect(resumeModeSource(settings)).toBe(expected);
	});
});
