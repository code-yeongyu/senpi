import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildAnthropicWarmPromptCacheParams } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

type Handler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined> | BeforeAgentStartEventResult | undefined;

const managers = new Set<SessionManager>();
afterEach(() => {
	for (const manager of managers) manager.dispose();
	managers.clear();
});

function harness(restore: boolean, manager = SessionManager.inMemory(), tokens = 750_000) {
	managers.add(manager);
	if (manager.getBranch().length === 0) {
		manager.appendMessage({ role: "user", content: "synthetic request", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("synthetic answer"));
	}
	if (restore) {
		manager.appendCustomEntry("compaction.agent-checkpoint", {
			schema: "senpi.compaction.agent-checkpoint.v1",
			data: { activeTools: [], thinkingLevel: null, timestamp: Date.now() - 1000 },
		});
	}
	let handler: Handler | undefined;
	compactionExtension(
		Object.assign(Object.create(null), {
			on: (event: string, callback: unknown) => {
				if (event === "before_agent_start") handler = callback as Handler;
			},
			appendEntry: vi.fn(),
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			events: { emit: vi.fn() },
			sendMessage: vi.fn(),
		}) as ExtensionAPI,
	);
	const ctx = {
		hasUI: false,
		mode: "tui",
		ui: { notify: vi.fn() },
		sessionManager: manager,
		modelRegistry: {},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
		getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, speculativeEnabled: false }),
		getMessageRevision: () => 1,
		beginCompaction: () => undefined,
		getSystemPrompt: () => "fixed synthetic system",
	} as unknown as ExtensionContext;
	const request = async () => {
		if (!handler) throw new Error("missing before_agent_start handler");
		const result = await handler(
			{
				type: "before_agent_start",
				prompt: "synthetic fresh prompt",
				systemPrompt: "fixed synthetic system",
				systemPromptOptions: { cwd: process.cwd() },
			} as BeforeAgentStartEvent,
			ctx,
		);
		const notice = result?.message;
		const appendNotice = () => {
			if (!notice) return;
			const { customType, content, display, details } = notice;
			manager.appendCustomMessageEntry(customType, content, display, details);
		};
		if (notice?.placement === "before-prompt") appendNotice();
		manager.appendMessage({ role: "user", content: "synthetic fresh prompt", timestamp: 2 });
		if (notice?.placement !== "before-prompt") appendNotice();
		const model = getBuiltinModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("missing synthetic model");
		return {
			result,
			payload: buildAnthropicWarmPromptCacheParams(
				model,
				{
					systemPrompt: result?.systemPrompt ?? "fixed synthetic system",
					messages: convertToLlm(manager.buildSessionContext().messages),
				},
				{ cacheRetention: "short" },
			),
		};
	};
	return {
		manager,
		request,
	};
}

describe("persisted late token budget reminder cache prefix", () => {
	it.each([false, true])(
		"keeps distinct-epoch notices behind stable checkpoints with restoration=%s",
		async (restore) => {
			const h = harness(restore);
			const first = await h.request();
			h.manager.appendCompaction("synthetic summary", null, 750_000);
			const second = await harness(restore, h.manager, 755_000).request();
			expect(first.result?.systemPrompt).toBeUndefined();
			expect(second.result?.systemPrompt).toBeUndefined();
			expect(first.result?.message?.display).toBe(false);
			for (const request of [first, second]) {
				expect(request.result?.message?.content).toContain("[context budget]");
				expect(request.result?.message?.placement).toBe("before-prompt");
			}
			expect(first.result?.message?.content).not.toEqual(second.result?.message?.content);
			const remaining = [first, second].map((request) =>
				Number(String(request.result?.message?.content).match(/\[context budget\][^\d]*(\d+)/)?.[1]),
			);
			expect(remaining[0]).toBeGreaterThan(remaining[1]);
			expect(h.manager.buildSessionContext().messages.at(-1)).toMatchObject({
				role: "user",
				content: "synthetic fresh prompt",
			});
			expect(JSON.stringify(first.payload.system)).toBe(JSON.stringify(second.payload.system));
			expect(JSON.stringify(first.payload.tools)).toBe(JSON.stringify(second.payload.tools));
			expect(first.payload.system).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ cache_control: expect.objectContaining({ type: "ephemeral" }) }),
				]),
			);
		},
	);

	it.each(["reload", "resume"])("does not repeat a persisted notice after %s inside the same epoch", async (mode) => {
		const directory = makeTempDir(join(tmpdir(), "budget-epoch-"));
		const manager = SessionManager.create(directory, directory);
		const first = await harness(false, manager).request();
		expect(first.result?.message?.content).toContain("[context budget]");
		const file = manager.getSessionFile();
		if (!file) throw new Error("missing persisted session file");
		if (mode === "resume") manager.dispose();
		const restored = mode === "resume" ? SessionManager.open(file) : manager;
		const second = await harness(false, restored, 755_000).request();
		expect(second.result?.message).toBeUndefined();
		expect(restored.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});
});
