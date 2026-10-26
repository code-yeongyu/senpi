// senpi#3864 (review r5 finding 2): only a fact refresh that carries a bound turn end may set `lastStop`. A refresh
// with no bound end (a wake, timer, goal-store or idle refresh) sets nothing, even while the goal collector still
// returns the previous run's end because the goal extension has not yet processed the next run's agent_start.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import type { LifecycleSessionBinding } from "../../../src/core/lifecycle-session-binding.ts";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`no signal within ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lifecycleRecords(harness: Harness): LifecycleRecord[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => (entry as { data: LifecycleRecord }).data);
}

it("sets no stop on run B from a wake refresh before the goal extension sees B's start", async () => {
	// Given run A whose own end is an abort, and an extension registered before the goal extension that holds B's
	// agent_start processing until a wake refresh lands, so the goal collector still returns A's end.
	let starts = 0;
	let refreshed: (() => void) | undefined;
	let stopAtRefresh: SessionLifecycle["lastStop"] | "not-observed" = "not-observed";
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("agent_start", async () => {
					starts += 1;
					if (starts !== 2) return;
					const landed = new Promise<void>((resolve) => {
						refreshed = resolve;
					});
					pi.events.emit("wake_source_state", { source: "test-monitor", activeCount: 0 });
					await within(landed, 5000);
					stopAtRefresh = h.session.lifecycle.lastStop;
				});
			},
			goalExtension,
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	const binding = (h.session as unknown as { _lifecycleBinding: LifecycleSessionBinding })._lifecycleBinding;
	const goalFacts = binding.controller.goalFacts.bind(binding.controller);
	vi.spyOn(binding.controller, "goalFacts").mockImplementation((goal, input, stop) => {
		goalFacts(goal, input, stop);
		if (stop === undefined) refreshed?.();
	});
	h.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);
	await h.session.prompt("Start the parser.");
	await h.session.waitForSettledSessionWork();
	const runA = lifecycleRecords(h).at(-1)?.runId;
	expect(h.session.lifecycle.lastStop).toMatchObject({ cause: "aborted", runId: runA });

	// When run B starts and the wake refresh lands before the goal extension processes B's agent_start.
	h.setResponses([fauxAssistantMessage("The parser is started.")]);
	await h.session.prompt("Continue.");
	await h.session.waitForSettledSessionWork();

	// Then the refresh set nothing on B, no record of B carries a stop, and B's clean end leaves none.
	expect(stopAtRefresh).toBeUndefined();
	const runB = lifecycleRecords(h).at(-1)?.runId;
	expect(runB).not.toBe(runA);
	for (const record of lifecycleRecords(h).filter((entry) => entry.runId === runB))
		expect(record.lastStop).toBeUndefined();
	expect(h.session.lifecycle.lastStop).toBeUndefined();
});
