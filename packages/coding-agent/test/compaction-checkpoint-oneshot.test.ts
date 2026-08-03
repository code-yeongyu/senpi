/**
 * Post-change pin for todo 13c (INTENTIONAL cross-lane semantic change).
 *
 * The checkpoint restoration directive no longer rides the system prompt for
 * every request inside the 60s checkpoint window. Exactly one hidden
 * restoration message carries it once after a compaction checkpoint, and the
 * system prompt stays byte-identical to the base prompt on every request.
 *
 * The pre-change behavior is pinned in
 * `test/compaction/checkpoint-directive-characterization.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import compactionExtension from "../src/core/extensions/builtin/compaction/index.ts";
import { POST_COMPACT_RESTORATION_CUSTOM_TYPE } from "../src/core/extensions/builtin/compaction/restoration-tracker.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const RESTORATION_DIRECTIVE = "[restore checkpointed session agent configuration after compaction]";
const BASE_SYSTEM_PROMPT = "BASE SYSTEM PROMPT";

type BeforeAgentStart = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined> | BeforeAgentStartEventResult | undefined;

interface OneShotHarness {
	beforeAgentStart: BeforeAgentStart;
	ctx: ExtensionContext;
	sessionManager: SessionManager;
	recordCheckpoint: (timestamp: number) => void;
}

function createHarness(checkpointTimestamp: number): OneShotHarness {
	const sessionManager = SessionManager.inMemory();
	const recordCheckpoint = (timestamp: number): void => {
		sessionManager.appendCustomEntry("compaction.agent-checkpoint", {
			schema: "senpi.compaction.agent-checkpoint.v1",
			data: {
				activeTools: ["read", "bash"],
				thinkingLevel: null,
				modelId: "faux-model",
				agentName: "senpi",
				timestamp,
			},
		});
	};
	recordCheckpoint(checkpointTimestamp);

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

	return { beforeAgentStart, ctx, sessionManager, recordCheckpoint };
}

function startEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "next request",
		systemPrompt: BASE_SYSTEM_PROMPT,
		systemPromptOptions: { cwd: process.cwd() },
	} as BeforeAgentStartEvent;
}

describe("checkpoint restoration directive is delivered once, not per request", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("carries the directive in the first post-checkpoint request as a hidden one-shot message", async () => {
		const harness = createHarness(Date.now() - 1_000);

		const result = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(result?.message?.customType).toBe(POST_COMPACT_RESTORATION_CUSTOM_TYPE);
		expect(result?.message?.display).toBe(false);
		expect(String(result?.message?.content)).toContain(RESTORATION_DIRECTIVE);
		expect(String(result?.message?.content)).toContain("Restore checkpointed session configuration:");
	});

	it("never rewrites the system prompt, even inside the 60s window", async () => {
		const harness = createHarness(Date.now() - 1_000);

		const result = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(result?.systemPrompt).toBeUndefined();
	});

	it("delivers the directive exactly once for a single checkpoint", async () => {
		const harness = createHarness(Date.now() - 1_000);

		const first = await harness.beforeAgentStart(startEvent(), harness.ctx);
		vi.setSystemTime(Date.now() + 5_000);
		const second = await harness.beforeAgentStart(startEvent(), harness.ctx);
		vi.setSystemTime(Date.now() + 5_000);
		const third = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(String(first?.message?.content)).toContain(RESTORATION_DIRECTIVE);
		expect(second?.message).toBeUndefined();
		expect(third?.message).toBeUndefined();
	});

	it("keeps the base system prompt byte-identical after the 60s window elapses", async () => {
		const harness = createHarness(Date.now() - 61_000);

		const result = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(result?.systemPrompt).toBeUndefined();
		expect(result?.message).toBeUndefined();
	});

	it("skips the directive for a stale checkpoint outside the 60s window", async () => {
		const harness = createHarness(Date.now() - 120_000);

		const result = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(result).toBeUndefined();
	});

	it("delivers the directive again after a newer checkpoint is recorded", async () => {
		const harness = createHarness(Date.now() - 1_000);

		const first = await harness.beforeAgentStart(startEvent(), harness.ctx);
		vi.setSystemTime(Date.now() + 10_000);
		harness.recordCheckpoint(Date.now());
		const second = await harness.beforeAgentStart(startEvent(), harness.ctx);

		expect(String(first?.message?.content)).toContain(RESTORATION_DIRECTIVE);
		expect(String(second?.message?.content)).toContain(RESTORATION_DIRECTIVE);
	});
});
