// senpi#3227 regression: an unbounded turn keeps running forever. The inactivity lease
// and the hard max runtime must end it as a system abort that carries the deadline detail.
// The lease renews only on tool execution events and admitted user input.
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadlineStopPendingSinceLastTurn } from "../../../src/core/turn-deadline.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

/** Bounded wait for a session event under fake timers: the escape hatch runs on the real clock. */
function waitForSessionEvent<K extends Harness["events"][number]["type"]>(
	harness: Harness,
	type: K,
	predicate: (event: Extract<Harness["events"][number], { type: K }>) => boolean = () => true,
	timeoutMs = 5_000,
): Promise<Extract<Harness["events"][number], { type: K }>> {
	type Matched = Extract<Harness["events"][number], { type: K }>;
	const existing = (harness.eventsOfType(type) as Matched[]).find(predicate);
	if (existing !== undefined) return Promise.resolve(existing);
	return new Promise((resolve, reject) => {
		const deadline = setRealTimeout(() => {
			unsubscribe();
			reject(new Error(`Timed out waiting for session event "${type}"`));
		}, timeoutMs);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== type) return;
			const candidate = event as Matched;
			if (!predicate(candidate)) return;
			clearRealTimeout(deadline);
			unsubscribe();
			resolve(candidate);
		});
	});
}

/** Tool calls the model issued whose `tool_execution_end` has not arrived yet. */
function unfinishedToolCallIds(harness: Harness): string[] {
	const ended = new Set(harness.eventsOfType("tool_execution_end").map((event) => event.toolCallId));
	return harness
		.eventsOfType("message_end")
		.flatMap((event) => (event.message.role === "assistant" ? event.message.content : []))
		.flatMap((block) => (block.type === "toolCall" && !ended.has(block.id) ? [block.id] : []));
}

/**
 * Advances fake time in one-second steps, but never past an unfinished tool call: the loop may await real work
 * between the model's tool call and the tool's start (the prepared pipeline hashes its batch plan through Web Crypto),
 * and one large jump would run the next fake timer before that work settles (senpi#5797).
 */
async function advanceAcrossToolCalls(harness: Harness, totalMs: number): Promise<void> {
	for (let elapsed = 0; elapsed < totalMs; elapsed += 1_000) {
		if (harness.eventsOfType("agent_end").some((event) => event.aborted === true)) return;
		await vi.advanceTimersByTimeAsync(1_000);
		for (const id of unfinishedToolCallIds(harness))
			await waitForSessionEvent(harness, "tool_execution_end", (event) => event.toolCallId === id);
	}
}

const INACTIVITY_MS = 120_000;
const MAX_RUNTIME_MS = 300_000;

const quietTool: AgentTool = {
	name: "tick",
	label: "Tick",
	description: "Records a tick and returns immediately",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ticked" }], details: {} }),
};

describe("turn inactivity lease and max runtime (senpi#3227)", () => {
	let harness: Harness;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		harness?.cleanup();
	});

	async function createLeaseHarness(
		settings?: {
			turn_inactivity_ms?: number;
			turn_max_runtime_ms?: number;
		},
		slow = false,
	): Promise<Harness> {
		harness = await createHarness({
			settings,
			tools: [quietTool],
			initialActiveToolNames: ["tick"],
			// A deadline test holds the turn open with a slow stream so the lease fires mid-turn.
			...(slow ? { fauxStreamOptions: { tokensPerSecond: 1 } } : {}),
		});
		return harness;
	}

	it("ends a silent provider turn with an inactivity deadline after the grace, keeping partial text", async () => {
		const h = await createLeaseHarness({ turn_inactivity_ms: INACTIVITY_MS, turn_max_runtime_ms: 0 }, true);
		h.setResponses([fauxAssistantMessage(`partial answer ${"then silence ".repeat(150)}`)]);
		const ended = waitForSessionEvent(h, "agent_end", (event) => event.aborted === true);

		const prompting = h.session.prompt("say something then go quiet");
		// When the lease expires, a 10 s grace lets the abort terminalize first
		await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
		await vi.advanceTimersByTimeAsync(10_000);
		const agentEnd = await ended;
		await prompting;

		expect(agentEnd.abortSource).toBe("system");
		const deadline = agentEnd.deadline;
		expect(deadline?.kind).toBe("inactivity");
		expect(deadline?.limitMs).toBe(INACTIVITY_MS);
		expect(deadline?.elapsedMs).toBeGreaterThanOrEqual(INACTIVITY_MS);
		// Then the partial streamed text is kept
		expect(getAssistantTexts(h).some((text) => text.includes("partial answer"))).toBe(true);
		await waitForSessionEvent(h, "agent_idle");
	}, 60_000);

	// senpi#5797: the prepared pipeline awaits real work (its Web Crypto plan digest) between the model's tool call and
	// tool_execution_start. The drive waits out that real hop instead of jumping fake time across it, so both pipelines
	// are held to the same contract: tool progress renews the lease, and only the max runtime ends the turn.
	it.each(["legacy", "prepared"] as const)(
		"renews on tool execution progress so only the hard max runtime stops the turn (%s pipeline)",
		async (pipeline) => {
			vi.stubEnv("SENPI_EXECUTION_PIPELINE", pipeline);
			// Each step streams ~80 s of text (faux: 4 chars per token, 1 token/s), then calls `tick`: only the tool events renew the 120 s lease,
			// so the turn outlives several leases and the 300 s cap is what ends it.
			const h = await createLeaseHarness(
				{ turn_inactivity_ms: INACTIVITY_MS, turn_max_runtime_ms: MAX_RUNTIME_MS },
				true,
			);
			const step = () =>
				fauxAssistantMessage([fauxText(`step ${"working ".repeat(40)}`), fauxToolCall("tick", {})], {
					stopReason: "toolUse",
				});
			h.setResponses([step(), step(), step(), step(), step()]);
			// This wait spans the whole stepped drive (~300 one-second steps), not one jump: a row measured 205-314 ms on an
			// idle host, so 45 s leaves >140x headroom for a loaded CI worker while staying under the 60 s test timeout.
			const ended = waitForSessionEvent(h, "agent_end", (event) => event.aborted === true, 45_000);

			const prompting = h.session.prompt("keep reporting without ever finishing");
			await advanceAcrossToolCalls(h, MAX_RUNTIME_MS + 10_000);
			const agentEnd = await ended;
			await prompting;

			const deadline = agentEnd.deadline;
			expect(deadline?.kind).toBe("max_runtime");
			expect(deadline?.limitMs).toBe(MAX_RUNTIME_MS);
			expect(h.eventsOfType("tool_execution_end").length).toBeGreaterThanOrEqual(2);
		},
		60_000,
	);

	it("never fires when turn_inactivity_ms is 0", async () => {
		const h = await createLeaseHarness({ turn_inactivity_ms: 0, turn_max_runtime_ms: 0 });
		h.setResponses([fauxAssistantMessage("short answer")]);

		await h.session.prompt("hello");
		await vi.advanceTimersByTimeAsync(10 * INACTIVITY_MS + 10_000);

		expect(h.eventsOfType("agent_end").filter((event) => event.aborted === true)).toHaveLength(0);
	}, 60_000);

	it("does not renew on streaming text alone", async () => {
		const h = await createLeaseHarness({ turn_inactivity_ms: INACTIVITY_MS, turn_max_runtime_ms: 0 }, true);
		// ~130 one-second tokens: still streaming when the 120 s lease fires.
		h.setResponses([fauxAssistantMessage(`streaming text ${"no tool call ".repeat(130)}`)]);
		const ended = waitForSessionEvent(h, "agent_end", (event) => event.aborted === true);

		const prompting = h.session.prompt("talk but never use a tool");
		await vi.advanceTimersByTimeAsync(INACTIVITY_MS + 10_000);
		const agentEnd = await ended;
		await prompting;

		const deadline = agentEnd.deadline;
		expect(deadline?.kind).toBe("inactivity");
	}, 60_000);

	it("clears the deadline-stopped hold when the user prompts again", async () => {
		const h = await createLeaseHarness({ turn_inactivity_ms: INACTIVITY_MS, turn_max_runtime_ms: 0 }, true);
		// ~130 one-second tokens: still streaming when the 120 s lease fires.
		h.setResponses([fauxAssistantMessage(`stall ${"quiet ".repeat(130)}`)]);
		const ended = waitForSessionEvent(h, "agent_end", (event) => event.aborted === true);

		const first = h.session.prompt("first");
		await vi.advanceTimersByTimeAsync(INACTIVITY_MS + 10_000);
		await ended;
		await first;
		expect(deadlineStopPendingSinceLastTurn(h.session.sessionManager.getBranch())).toMatchObject({
			kind: "inactivity",
		});

		h.setResponses([fauxAssistantMessage("recovered answer")]);
		const resume = h.session.prompt("continue");
		await vi.advanceTimersByTimeAsync(10_000);
		await resume;
		expect(getAssistantTexts(h).some((text) => text.includes("recovered answer"))).toBe(true);
		expect(deadlineStopPendingSinceLastTurn(h.session.sessionManager.getBranch())).toBeUndefined();
	}, 60_000);
});
