import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolCall } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * senpi#6189: before a model-issued tool call runs, it waits on the session's event queue and then on its
 * tool_call hooks (the permission decision). Neither wait has a deadline, so a wait that never settled left no
 * trace. Each is now logged once to the session log at the stall threshold, naming the call and, for the queue,
 * the entry it waits behind. The waits themselves are unchanged.
 */

const STALL_THRESHOLD_MS = 30_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function stallWarnings(harness: Harness): Array<Record<string, unknown>> {
	let text: string;
	try {
		text = readFileSync(join(harness.tempDir, "agent", "logs", "session.log"), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => typeof entry.event === "string" && entry.event.endsWith("_stalled"));
}

function probeTool(pi: Parameters<ExtensionFactory>[0]): void {
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Returns at once.",
		parameters: Type.Object({ timeout: Type.Optional(Type.Number()) }),
		execute: async () => ({ content: [{ type: "text", text: "probe-ok" }], details: {} }),
	});
}

async function startProbeTurn(extensionFactory: ExtensionFactory, args: Parameters<typeof fauxToolCall>[1] = {}) {
	const harness = await createHarness({ extensionFactories: [extensionFactory] });
	const preflightEntered = deferred();
	const preflight = harness.session.preflightToolCall.bind(harness.session);
	vi.spyOn(harness.session, "preflightToolCall").mockImplementation(
		(toolCall: AgentToolCall, args: unknown, options) => {
			const pending = preflight(toolCall, args, options);
			preflightEntered.resolve();
			return pending;
		},
	);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", args, { id: "call_probe" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	return { harness, preflightEntered, prompt: harness.session.prompt("go") };
}

describe("#6189 tool-call waits without a deadline are logged when they stall", () => {
	const cleanups: Array<() => void> = [];
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("logs tool_call_event_queue_stalled naming the queue entry the call waits behind", async () => {
		const queueHeld = deferred();
		const releaseQueue = deferred();
		const { harness, preflightEntered, prompt } = await startProbeTurn((pi) => {
			probeTool(pi);
			pi.on("tool_execution_start", async () => {
				queueHeld.resolve();
				await releaseQueue.promise;
			});
		});
		cleanups.push(harness.cleanup);

		// given the call's own tool_execution_start handling never settles, so its preflight waits on the queue
		await Promise.all([queueHeld.promise, preflightEntered.promise]);
		expect(stallWarnings(harness)).toEqual([]);

		// when the wait reaches the stall threshold
		vi.advanceTimersByTime(STALL_THRESHOLD_MS);

		// then one warning names the call, the threshold and the entry at the head of the queue
		const warnings = stallWarnings(harness);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			level: "warn",
			event: "tool_call_event_queue_stalled",
			toolCallId: "call_probe",
			toolName: "probe",
			thresholdMs: STALL_THRESHOLD_MS,
			queueHead: "tool_execution_start:call_probe",
		});
		expect(warnings[0]?.queueDepth).toBeGreaterThanOrEqual(1);

		releaseQueue.resolve();
		await prompt;
		expect(stallWarnings(harness)).toHaveLength(1);
	});

	it("logs tool_call_preflight_stalled when a tool_call hook never decides", async () => {
		const hookEntered = deferred();
		const releaseHook = deferred();
		const { harness, prompt } = await startProbeTurn((pi) => {
			probeTool(pi);
			pi.on("tool_call", async () => {
				hookEntered.resolve();
				await releaseHook.promise;
				return undefined;
			});
		});
		cleanups.push(harness.cleanup);

		// given a tool_call hook (where the permission decision runs) that has not returned
		await hookEntered.promise;

		// when the preflight reaches the stall threshold
		vi.advanceTimersByTime(STALL_THRESHOLD_MS);

		// then one warning names the call
		const warnings = stallWarnings(harness);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			event: "tool_call_preflight_stalled",
			toolCallId: "call_probe",
			toolName: "probe",
			thresholdMs: STALL_THRESHOLD_MS,
		});

		releaseHook.resolve();
		await prompt;
	});

	it("keeps the 30 s preflight threshold for a call with a shorter timeout", async () => {
		const hookEntered = deferred();
		const releaseHook = deferred();
		const { harness, prompt } = await startProbeTurn(
			(pi) => {
				probeTool(pi);
				pi.on("tool_call", async () => {
					hookEntered.resolve();
					await releaseHook.promise;
					return undefined;
				});
			},
			{ timeout: 5 },
		);
		cleanups.push(harness.cleanup);

		// given a call with a 5 s timeout whose permission decision is still pending
		await hookEntered.promise;

		// when the decision outlasts the call's own timeout, then nothing is logged: that timeout bounds execution only
		vi.advanceTimersByTime(STALL_THRESHOLD_MS - 1);
		expect(stallWarnings(harness)).toEqual([]);

		// when it reaches 30 s, then one warning carries the 30 s threshold
		vi.advanceTimersByTime(1);
		const warnings = stallWarnings(harness);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ event: "tool_call_preflight_stalled", thresholdMs: STALL_THRESHOLD_MS });

		releaseHook.resolve();
		await prompt;
	});

	it("names the parent call of an eval-cell tool call in its preflight warning", async () => {
		const hookEntered = deferred();
		const releaseHook = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						hookEntered.resolve();
						await releaseHook.promise;
						return undefined;
					});
				},
			],
		});
		cleanups.push(harness.cleanup);

		// given a tool call issued from an eval cell, whose permission decision is pending
		const toolCall: AgentToolCall = { type: "toolCall", id: "call_child", name: "bash", arguments: {} };
		const preflight = harness.session.preflightToolCall(toolCall, {}, { parentToolCallId: "call_eval_cell" });
		await hookEntered.promise;

		// when the preflight reaches the stall threshold
		vi.advanceTimersByTime(STALL_THRESHOLD_MS);

		// then the warning names both the call and the eval cell's call
		const warnings = stallWarnings(harness);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			event: "tool_call_preflight_stalled",
			toolCallId: "call_child",
			toolName: "bash",
			parentToolCallId: "call_eval_cell",
		});

		releaseHook.resolve();
		await preflight;
	});

	it("logs nothing when the call's waits settle", async () => {
		const { harness, prompt } = await startProbeTurn((pi) => {
			probeTool(pi);
			pi.on("tool_call", async () => undefined);
		});
		cleanups.push(harness.cleanup);

		// given a turn whose tool call runs without stalling
		await prompt;

		// when the clock runs well past the threshold
		vi.advanceTimersByTime(4 * STALL_THRESHOLD_MS);

		// then the call ran and nothing was logged
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("probe-ok");
		expect(stallWarnings(harness)).toEqual([]);
	});
});
