import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { expect, vi } from "vitest";
import {
	createContextReductionState,
	readContextReductionState,
} from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];
const contextErrors = new WeakMap<Harness, string[]>();
export function textAssistant(id: number, tokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer ".repeat(Math.ceil((tokens * 4) / 7)) }],
		api: "faux-completion",
		provider: "faux",
		model: "frontier",
		stopReason: "stop",
		timestamp: id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
export function resultPair(id: number, name = "write", tokens = 900): StoredMessage[] {
	return [
		{
			...textAssistant(id, 0),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: `call-${id}`, name, arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: name,
			content: [{ type: "text", text: "data ".repeat(Math.ceil((tokens * 4) / 5)) }],
			isError: false,
			timestamp: id,
		},
	];
}
export function reductionSeed(): StoredMessage[] {
	return [
		{ role: "user", content: "context ".repeat(16_000), timestamp: 0 },
		textAssistant(1, 1_600),
		...Array.from({ length: 20 }, (_, index) => resultPair(index + 2, index % 3 === 0 ? "eval" : "write")).flat(),
		textAssistant(22, 1_600),
		{ role: "user", content: "Continue.", timestamp: 23 },
	];
}
export async function createReductionHarness(
	options: { maxTokens?: number; sessionManager?: SessionManager; siblingOf?: Harness } = {},
) {
	const continuations = vi.fn();
	const h = await createHarness({
		models: [{ id: "frontier", contextWindow: 100_000, maxTokens: options.maxTokens ?? 4_000 }],
		settings: {
			compaction: {
				enabled: false,
				speculativeEnabled: false,
				idleCompactionEnabled: false,
				toolAdmissionEnabled: false,
				restorationEnabled: false,
			},
		},
		persistSession: true,
		extensionFactories: [
			(pi) => {
				pi.sendMessage = continuations;
				compactionExtension(pi);
			},
		],
		...options,
	});
	const runner = h.getExtensionRunner();
	const errors: string[] = [];
	contextErrors.set(h, errors);
	runner.onError((error) => errors.push(error.error));
	const original = runner.createContext.bind(runner);
	const aborts = vi.fn<ExtensionContext["abort"]>();
	const queued = vi.fn(() => false);
	const compactions = vi.fn<ExtensionContext["compact"]>(() => {
		aborts("system");
	});
	vi.spyOn(runner, "createContext").mockImplementation(() => ({
		...original(),
		compact: compactions,
		abort: aborts,
		hasPendingMessages: queued,
	}));
	await h.session.bindExtensions({});
	return { h, compactions, aborts, continuations, queued };
}
export function appendReduction(h: Harness, messages: StoredMessage[]) {
	for (const message of messages) h.sessionManager.appendMessage(message);
}
export async function renderReduction(h: Harness) {
	const messages = await h.getExtensionRunner().emitContext(h.sessionManager.buildSessionContext().messages);
	expect(contextErrors.get(h)).toEqual([]);
	return messages;
}
export function savedReduction(h: Harness) {
	const entry = h.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === "senpi.context-reduction.v1");
	return entry?.type === "custom"
		? (readContextReductionState(entry.data) ?? createContextReductionState())
		: createContextReductionState();
}
export function reductionBytes(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
