import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { fallbackCircuitsFor } from "../../src/core/retry-fallback/circuit.ts";
import { computeSessionFailureReport } from "../../src/core/session-failure-report.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const retry = {
	enabled: true,
	maxRetries: 0,
	baseDelayMs: 0,
	fallbackChains: { [primary]: [fallback] },
};
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	vi.restoreAllMocks();
});

it("does not delay enabled-breaker primary recovery after the wall clock jumps backward", async () => {
	let elapsed = performance.now();
	const wall = Date.now();
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const wallClock = vi.spyOn(Date, "now").mockReturnValue(wall);
	const h = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		settings: { retry },
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503: overloaded" }),
		fauxAssistantMessage("fallback"),
		fauxAssistantMessage("after elapsed cooldown"),
	]);
	await h.session.prompt("open circuit");
	elapsed += 60_001;
	wallClock.mockReturnValue(wall - 86_400_000);
	await h.session.prompt("monotonic cooldown elapsed");
	expect(h.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-1"]);
});

it("still tries a circuit-open last entry when the current entry fails", async () => {
	const h = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: () => 0,
		settings: { retry },
	});
	harnesses.push(h);
	fallbackCircuitsFor(join(h.tempDir, "agent")).open(fallback, {
		now: 0,
		cooldownMs: 60_000,
		maxCooldownMs: 1_800_000,
	});
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503: overloaded" }),
		fauxAssistantMessage("last entry still serves"),
	]);
	await h.session.prompt("try the last entry");
	expect(h.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
	expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
});

it("does not count an unrelated next-day different-provider success after an abort", () => {
	const started = Date.parse("2026-09-27T00:00:00Z");
	const nextDay = started + 86_400_000;
	const aborted = fauxAssistantMessage("", { stopReason: "aborted", timestamp: started });
	const success = fauxAssistantMessage("unrelated", { timestamp: nextDay });
	success.provider = "other-provider";
	success.usage = { ...success.usage, input: 5000, cacheRead: 0 };
	const report = computeSessionFailureReport([
		{
			type: "message",
			id: "abort",
			parentId: null,
			timestamp: new Date(started + 50).toISOString(),
			message: aborted,
		},
		{
			type: "message",
			id: "user",
			parentId: "abort",
			timestamp: new Date(nextDay).toISOString(),
			message: { role: "user", content: "unrelated next-day question", timestamp: nextDay },
		},
		{
			type: "message",
			id: "success",
			parentId: "user",
			timestamp: new Date(nextDay + 100).toISOString(),
			message: success,
		},
	]);
	expect(report).toMatchObject({ abortedRequests: 1, postFailureRequests: 0, postFailureFullMissInputTokens: 0 });
});
