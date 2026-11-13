/**
 * senpi#6411 review of #6412: while a live model switch waits for Claude Code's confirmation, the session must stay
 * resumable on the selected model. A close in that window (a thinking-level change) keeps the lineage on that model,
 * a failed confirmation is written to session.log, and a confirmation that never comes retires the process after the
 * admission bound so the turn reattaches instead of hanging.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import { getSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { SESSION_TURN_ADMISSION_WAIT_MS } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-pump.ts";
import { cleanupResidentSessions, residentSession } from "../../helpers/anthropic-subscription-held-model-switch.ts";

const logs: Array<{ event: string; data: Record<string, unknown> }> = [];

afterEach(() => {
	vi.restoreAllMocks();
	resetContinuityObservabilityBoundary();
	logs.length = 0;
	cleanupResidentSessions();
});

function captureSessionLog(): void {
	overrideContinuityObservabilityBoundary({ log: (event, data) => logs.push({ event, data }) });
}

describe("senpi#6411 a pending live model switch keeps the session resumable", () => {
	it.each([
		{ name: "after the switch confirmed", confirmFirst: true },
		{ name: "while the switch still waits for confirmation", confirmFirst: false },
	])(
		"resumes the same lineage on the selected model when the thinking level changes $name",
		async ({ confirmFirst }) => {
			const { harness, queries, process0, model, setModelCall } = await residentSession();
			await harness.session.setModel(model("claude-next"));
			const pending = await setModelCall(0);
			if (confirmFirst) {
				pending.release();
				await getSession(harness.sessionManager.getSessionId())?.pendingModelSwitch?.done;
			}

			await harness
				.getExtensionRunner()
				.emit({ type: "thinking_level_select", level: "high", previousLevel: "off" });
			expect(getSession(harness.sessionManager.getSessionId())).toBeUndefined();
			await harness.session.prompt("second");

			expect(queries).toHaveLength(2);
			expect(queries[1]?.options).toMatchObject({ resume: process0.options?.sessionId, model: "claude-next" });
			expect(queries[1]?.submitted).toHaveLength(1);
		},
		30_000,
	);

	it("writes a failed confirmation on the live process to session.log", async () => {
		const { harness, model, setModelCall } = await residentSession();
		captureSessionLog();
		await harness.session.setModel(model("claude-next"));
		const pending = getSession(harness.sessionManager.getSessionId())?.pendingModelSwitch;

		(await setModelCall(0)).fail(new Error("Couldn't confirm model claude-next with the API"));
		await pending?.done;

		expect(logs).toContainEqual({
			event: "claude_sdk_oauth_model_switch_failed",
			data: { modelId: "claude-next", error: "Couldn't confirm model claude-next with the API" },
		});
	}, 30_000);

	it("reattaches on the selected model when the confirmation does not arrive within the admission bound", async () => {
		const { harness, queries, process0, model, setModelCall } = await residentSession();
		captureSessionLog();
		await harness.session.setModel(model("claude-next"));
		await setModelCall(0);
		// The bound is the admission timer; the test fires it itself once the turn starts waiting on the switch.
		const realSetTimeout = globalThis.setTimeout;
		let deadlineArmed!: (fire: () => void) => void;
		const armed = new Promise<() => void>((resolve) => {
			deadlineArmed = resolve;
		});
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delayMs?: number) => {
			if (delayMs !== SESSION_TURN_ADMISSION_WAIT_MS) return realSetTimeout(callback, delayMs);
			deadlineArmed(callback);
			return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);

		const prompted = harness.session.prompt("second");
		(await armed)();
		await prompted;

		expect(logs).toContainEqual({ event: "claude_sdk_oauth_model_switch_timeout", data: { modelId: "claude-next" } });
		expect(process0.submitted).toHaveLength(1);
		expect(queries).toHaveLength(2);
		expect(queries[1]?.options).toMatchObject({ resume: process0.options?.sessionId, model: "claude-next" });
		expect(queries[1]?.submitted).toHaveLength(1);
	}, 30_000);
});
