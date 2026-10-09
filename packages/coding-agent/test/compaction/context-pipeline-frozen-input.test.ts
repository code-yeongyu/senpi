/**
 * senpi#2525 review (H2): the builtin compaction `context` handler declares `mutatesMessages: false`, so
 * the runner hands it the live transcript. Every branch of its pipeline must derive, never write in
 * place. Each case below drives one branch on deep-frozen input, where an in-place write throws.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildCompactionContext } from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import { TOOL_RESULT_PLACEHOLDER } from "../../src/core/extensions/builtin/compaction/repair-tool-pairs.ts";
import type { ContextEvent, ExtensionContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const WINDOW = 100_000;
const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

function fauxModel(): Model<Api> {
	const registration = registerFauxProvider({ models: [{ id: "frozen-input", contextWindow: WINDOW }] });
	registrations.push(registration);
	return registration.getModel();
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	Object.freeze(value);
	for (const nested of Object.values(value)) deepFreeze(nested, seen);
	return value;
}

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: unknown[], timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: USAGE,
		stopReason: "toolUse",
		timestamp,
	} as AgentMessage;
}

function toolResult(id: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	} as AgentMessage;
}

function readPair(index: number, text: string): AgentMessage[] {
	return [
		assistant(
			[{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `/src/f${index}.ts` } }],
			index * 2,
		),
		toolResult(`call-${index}`, text, index * 2 + 1),
	];
}

function run(
	messages: AgentMessage[],
	options: { toolAdmissionEnabled?: boolean; breakerFallback?: boolean; usageTokens?: number },
): AgentMessage[] {
	const ctx = {
		model: fauxModel(),
		cwd: process.cwd(),
		sessionManager: SessionManager.inMemory(),
		getContextUsage: () => ({ tokens: options.usageTokens ?? 1_000, contextWindow: WINDOW, percent: 1 }),
	} as unknown as ExtensionContext;
	const event: ContextEvent = { type: "context", messages: deepFreeze(messages) };
	return buildCompactionContext({
		event,
		ctx,
		contextWindow: WINDOW,
		promptContextWindow: WINDOW,
		toolAdmissionEnabled: options.toolAdmissionEnabled ?? false,
		breakerFallback: options.breakerFallback ?? false,
		laneOwnsCompaction: false,
		emergencyPruneLatch: createEmergencyPruneLatch(),
	}) as AgentMessage[];
}

function firstText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message) || !Array.isArray(message.content)) return "";
	const part = message.content[0];
	return part && part.type === "text" ? part.text : "";
}

describe("compaction context pipeline on frozen input (senpi#2525)", () => {
	it("admission projects an over-cap tool result without writing to the frozen message", () => {
		const huge = "x".repeat(48_000);
		const messages = [...readPair(0, huge), { role: "user", content: "next", timestamp: 9 } as AgentMessage];

		const out = run(messages, { toolAdmissionEnabled: true });

		const admitted = out.find((message) => message.role === "toolResult");
		expect(firstText(admitted).length).toBeLessThan(huge.length);
		expect(firstText(messages[1])).toBe(huge);
	});

	it("the reduction pass clears old tool results and shortens long assistant text without writing in place", () => {
		const longReply = "an explanation that runs well past the shrink threshold. ".repeat(160);
		const messages: AgentMessage[] = [{ role: "user", content: "start", timestamp: -2 } as AgentMessage];
		messages.push(assistant([{ type: "text", text: longReply }], -1));
		for (let index = 0; index < 10; index += 1) messages.push(...readPair(index, `file ${index} `.repeat(300)));
		const before = JSON.stringify(messages);

		const out = run(messages, { breakerFallback: true });

		expect(JSON.stringify(out)).not.toBe(before);
		expect(firstText(out.find((message) => message.role === "toolResult"))).not.toBe(firstText(messages[3]));
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("pair repair replaces an orphan tool result on a turn the emergency prune leaves alone", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "go", timestamp: 0 } as AgentMessage,
			toolResult("call-missing", "orphaned output", 1),
			...readPair(1, "small file"),
		];

		const out = run(messages, {});

		const orphan = out.find((message) => message.role === "toolResult" && message.toolCallId === "call-missing");
		expect(
			orphan && "content" in orphan && Array.isArray(orphan.content) ? orphan.content[0] : undefined,
		).toMatchObject({ type: "text", text: TOOL_RESULT_PLACEHOLDER });
		expect(firstText(messages[1])).toBe("orphaned output");
	});

	it("clearing old tool results, the last reduction step, derives its replacement messages", () => {
		const messages: AgentMessage[] = [];
		for (let index = 0; index < 10; index += 1) {
			messages.push(...readPair(index, `file ${index} `.repeat(300)));
			messages.push({ role: "user", content: `next ${index}`, timestamp: index * 2 + 1.5 } as AgentMessage);
		}
		const before = JSON.stringify(messages);

		const out = run(messages, { breakerFallback: true });

		const results = out.filter((message) => message.role === "toolResult");
		expect(
			results.some((message) => firstText(message) !== firstText(messages[1]) && firstText(message).length < 200),
		).toBe(true);
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("admission projects an over-cap string tool result without writing to the frozen message", () => {
		const huge = "y".repeat(48_000);
		const stringResult = { ...toolResult("call-0", "", 1), content: huge } as unknown as AgentMessage;
		const messages = [
			readPair(0, "")[0] as AgentMessage,
			stringResult,
			{ role: "user", content: "next", timestamp: 9 } as AgentMessage,
		];

		const out = run(messages, { toolAdmissionEnabled: true });

		expect(firstText(out.find((message) => message.role === "toolResult")).length).toBeLessThan(huge.length);
		expect((messages[1] as unknown as { content: string }).content).toBe(huge);
	});
});
