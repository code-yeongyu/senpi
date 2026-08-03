/**
 * Characterization of the checkpoint restoration directive delivery.
 *
 * PRE-CHANGE (pinned green before todo 13c, output captured in
 * local-ignore/qa-evidence/20260801-resident-reuse/task-13-precharacterization-60s-window.txt):
 *   1. every `before_agent_start` inside the 60s checkpoint window appended the
 *      directive to the system prompt (N requests -> N copies);
 *   2. the system prompt was left untouched once the window elapsed;
 *   3. the directive NEVER travelled as a one-shot message.
 *
 * POST-CHANGE (asserted below, cross-lane and intentional — see changes.md):
 *   1./3. the system prompt is never rewritten and the directive rides the
 *      one-shot hidden restoration message exactly once;
 *   2. unchanged — a checkpoint older than 60s still delivers nothing.
 *
 * Each assertion below states the pre-change behavior it replaces, so the
 * semantic delta is a visible diff rather than silent drift. Delivery details
 * of the new behavior live in `test/compaction-checkpoint-oneshot.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const RESTORATION_DIRECTIVE = "[restore checkpointed session agent configuration after compaction]";
const BASE_SYSTEM_PROMPT = "BASE SYSTEM PROMPT";

type BeforeAgentStart = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined> | BeforeAgentStartEventResult | undefined;

function createHarness(checkpointTimestamp: number): { beforeAgentStart: BeforeAgentStart; ctx: ExtensionContext } {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry("compaction.agent-checkpoint", {
		schema: "senpi.compaction.agent-checkpoint.v1",
		data: {
			activeTools: ["read"],
			thinkingLevel: null,
			modelId: "faux-model",
			agentName: "senpi",
			timestamp: checkpointTimestamp,
		},
	});

	let beforeAgentStart: BeforeAgentStart | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "before_agent_start") beforeAgentStart = handler as BeforeAgentStart;
		},
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off" as const,
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	}) as ExtensionAPI;
	compactionExtension(api);
	if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");

	const ctx = {
		hasUI: false,
		mode: "tui",
		ui: Object.assign(Object.create(null), { notify: vi.fn() }),
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry: Object.create(null),
		model: undefined,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: 10, contextWindow: 200_000, percent: 0 }),
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(),
		beginCompaction: vi.fn(() => undefined),
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => BASE_SYSTEM_PROMPT,
	} as unknown as ExtensionContext;

	return { beforeAgentStart, ctx };
}

function startEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "next request",
		systemPrompt: BASE_SYSTEM_PROMPT,
		systemPromptOptions: { cwd: process.cwd() },
	} as BeforeAgentStartEvent;
}

describe("checkpoint directive relocation: 60s system-prompt window -> one-shot message", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("WAS: appended the directive to the system prompt on EVERY request inside the window — NOW: never", async () => {
		const harness = createHarness(Date.now() - 1_000);

		const first = await harness.beforeAgentStart(startEvent(), harness.ctx);
		vi.setSystemTime(Date.now() + 30_000);
		const second = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(first?.systemPrompt).toBeUndefined();
		expect(second?.systemPrompt).toBeUndefined();
	});

	it("UNCHANGED: delivers nothing once the 60s window has elapsed", async () => {
		const harness = createHarness(Date.now() - 61_000);

		const result = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(result?.systemPrompt).toBeUndefined();
		expect(result?.message).toBeUndefined();
	});

	it("WAS: carried in the system prompt, never as a message — NOW: carried once as a hidden message", async () => {
		const harness = createHarness(Date.now() - 1_000);

		const result = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(result?.systemPrompt).toBeUndefined();
		expect(String(result?.message?.content)).toContain(RESTORATION_DIRECTIVE);
		expect(String(result?.message?.content)).toContain("Restore checkpointed session configuration:");
	});
});
