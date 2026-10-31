import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import {
	TURN_END_LIVENESS_ENTRY_TYPE,
	TURN_END_LIVENESS_EVENT,
	type TurnEndLivenessVerdict,
} from "../../../src/core/extensions/builtin/goal/turn-end-liveness.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3863: at every turn end the goal extension publishes whether the session is waiting, continuing,
// stalled or done, from the outcomes the goal lane and the todo-owed backstop produced.

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

type Probe = {
	readonly verdicts: TurnEndLivenessVerdict[];
	publishWakeSource(source: string, count: number): void;
	verdictAt(count: number, timeoutMs: number): Promise<TurnEndLivenessVerdict | "timeout">;
};

async function livenessHarness(settings?: Record<string, unknown>): Promise<{ h: Harness; probe: Probe }> {
	const verdicts: TurnEndLivenessVerdict[] = [];
	const waiters = new Set<() => void>();
	let api: ExtensionAPI | undefined;
	const probe = (pi: ExtensionAPI): void => {
		api = pi;
		pi.events.on(TURN_END_LIVENESS_EVENT, (data) => {
			verdicts.push((data as { verdict: TurnEndLivenessVerdict }).verdict);
			for (const wake of [...waiters]) wake();
		});
	};
	const verdictAt = (count: number, timeoutMs: number): Promise<TurnEndLivenessVerdict | "timeout"> =>
		new Promise((resolve) => {
			const settle = (): void => {
				const verdict = verdicts[count - 1];
				if (verdict === undefined) return;
				clearTimeout(timer);
				waiters.delete(settle);
				resolve(verdict);
			};
			const timer = setTimeout(() => {
				waiters.delete(settle);
				resolve("timeout");
			}, timeoutMs);
			waiters.add(settle);
			settle();
		});
	const h = await createHarness({ extensionFactories: [goalExtension, probe], ...(settings ? { settings } : {}) });
	harnesses.push(h);
	const runner = h.getExtensionRunner();
	runner.setUIContext(runner.getUIContext(), "tui");
	return {
		h,
		probe: {
			verdicts,
			publishWakeSource: (source, activeCount) => api?.events.emit(WAKE_SOURCE_STATE_EVENT, { source, activeCount }),
			verdictAt,
		},
	};
}

function nextAgentStart(h: Harness, timeoutMs: number): Promise<"started" | "timeout"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsubscribe();
			resolve("timeout");
		}, timeoutMs);
		const unsubscribe = h.session.subscribe((event: AgentSessionEvent) => {
			if (event.type !== "agent_start") return;
			clearTimeout(timer);
			unsubscribe();
			resolve("started");
		});
	});
}

it("a goal with unmet work and nothing armed reports continuing and the host continues", async () => {
	const { h, probe } = await livenessHarness();
	h.setResponses([
		fauxAssistantMessage("Started on the docs."),
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The docs are current."),
	]);

	await h.session.prompt("/goal Keep the docs current");
	expect(await probe.verdictAt(2, 10_000)).toEqual({ kind: "done" });

	expect(probe.verdicts).toEqual([{ kind: "continuing", via: "goal" }, { kind: "done" }]);
	expect(h.faux.state.callCount).toBe(3);
}, 20_000);

it("a running child holds the goal as waiting, and its completion wakes the parent once", async () => {
	const { h, probe } = await livenessHarness();
	probe.publishWakeSource("senpi-task", 1);
	h.setResponses([
		fauxAssistantMessage("Waiting for the review child."),
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Review merged."),
	]);

	await h.session.prompt("/goal Land the reviewed change");
	const first = await probe.verdictAt(1, 10_000);

	expect(first).toMatchObject({ kind: "waiting" });
	expect(first !== "timeout" && first.kind === "waiting" ? first.on : []).toEqual(
		expect.arrayContaining([{ kind: "wake-source", source: "senpi-task" }]),
	);
	expect(h.faux.state.callCount).toBe(1);

	const woken = nextAgentStart(h, 10_000);
	probe.publishWakeSource("senpi-task", 0);
	expect(await woken).toBe("started");
	expect(await probe.verdictAt(2, 10_000)).toEqual({ kind: "done" });
	expect(h.faux.state.callCount).toBe(3);
}, 20_000);

it("a turn the core will retry reports continuing via retry and records no stall", async () => {
	const { h, probe } = await livenessHarness({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate_limit_error: slow down" }),
		fauxAssistantMessage("Here is the summary."),
	]);

	await h.session.prompt("summarize the open issues");
	expect(await probe.verdictAt(2, 10_000)).toEqual({ kind: "done" });

	expect(probe.verdicts).toEqual([{ kind: "continuing", via: "retry" }, { kind: "done" }]);
	expect(h.faux.state.callCount).toBe(2);
	expect(
		h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === TURN_END_LIVENESS_ENTRY_TYPE),
	).toEqual([]);
}, 20_000);

it("a turn that ends on a provider error records a durable stall with the reset time", async () => {
	const { h, probe } = await livenessHarness({ retry: { enabled: false } });
	const reset = "2099-01-01T00:00:00.000Z";
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `usage limit reached; blocked until ${reset}` }),
	]);

	await h.session.prompt("summarize the open issues");
	await probe.verdictAt(1, 10_000);

	const expected = { kind: "stalled", reason: "provider-error", retryAtMs: Date.parse(reset) };
	expect(probe.verdicts).toEqual([expected]);
	const entries = h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === TURN_END_LIVENESS_ENTRY_TYPE);
	expect(entries.map((entry) => (entry as { data?: unknown }).data)).toEqual([
		{ verdict: expected, openWork: { kind: "none" } },
	]);
}, 20_000);
