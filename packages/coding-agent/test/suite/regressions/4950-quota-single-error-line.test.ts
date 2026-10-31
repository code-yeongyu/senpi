import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#4950: one provider failure renders one error line. The assistant row already shows the
// classified usage-limit text, so agent_end must not add a second line for the same failure.

type AgentEnd = Extract<AgentSessionEvent, { type: "agent_end" }>;

const QUOTA_BODY =
	'429 {"error":{"message":"You\'ve reached your monthly usage limit","type":"exceeded_current_quota_error"}}';

function failedTurn(errorMessage: string, providerDiagnostic: ProviderDiagnostic): AssistantMessage {
	return { ...fauxAssistantMessage("", { stopReason: "error", errorMessage }), providerDiagnostic };
}

function agentEndFixture() {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { setScrollbackReplayHold: vi.fn(), requestRender: vi.fn() },
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		streamingReveal: { stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		detachAssistantTextSegments: vi.fn(),
		clearPendingTools: vi.fn(),
		showError: vi.fn<(message: string) => void>(),
	};
}

describe("one error line per provider failure (senpi#4950)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function agentEndOf(response: AssistantMessage): Promise<AgentEnd> {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([response]);
		await harness.session.prompt("go");
		const ended = harness.eventsOfType("agent_end").at(-1);
		if (ended === undefined) throw new Error("no agent_end");
		return ended;
	}

	async function errorLinesAtAgentEnd(event: AgentEnd): Promise<string[]> {
		const fixture = agentEndFixture();
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
		await Reflect.apply(handleEvent, fixture, [event]);
		return fixture.showError.mock.calls.map(([line]) => line);
	}

	it("adds no unclassified line after the classified usage-limit row", async () => {
		const ended = await agentEndOf(
			failedTurn(QUOTA_BODY, {
				category: "quota",
				httpStatus: 429,
				code: "exceeded_current_quota_error",
				evidence: "structured_code",
			}),
		);
		expect(ended.failure?.category).toBe("quota");
		expect(await errorLinesAtAgentEnd(ended)).toEqual([]);
	});

	it("adds no second line for a quota failure the classifiers already agreed on", async () => {
		const ended = await agentEndOf(
			failedTurn('429 {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}', {
				category: "quota",
				httpStatus: 429,
				code: "insufficient_quota",
				evidence: "structured_code",
			}),
		);
		expect(ended.failure?.category).toBe("quota");
		expect(await errorLinesAtAgentEnd(ended)).toEqual([]);
	});

	it("still shows the reason and action once when the row had no classified text", async () => {
		const ended = await agentEndOf(
			failedTurn("boom", { category: "unknown", httpStatus: 418, evidence: "structured_status" }),
		);
		const lines = await errorLinesAtAgentEnd(ended);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Action:");
	});
});
