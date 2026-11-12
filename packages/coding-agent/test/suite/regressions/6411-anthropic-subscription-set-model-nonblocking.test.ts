/**
 * senpi#6411: switching models on an anthropic-subscription session with a live Claude Code process must not
 * wait for that process's `setModel`, which confirms the model with the API (80-280 ms, 15 s when unreachable).
 * The switch is applied before the next turn instead: a prompt sent right after `set_model` runs on the new model,
 * a failed switch reattaches the same lineage on a fresh process, and back-to-back switches apply in order.
 *
 * Drives a real AgentSession through the real provider stream and resident session registry against a scripted
 * SDK whose `setModel` settles only when the test releases it, so every ordering is asserted by events.
 */

import { afterEach, describe, expect, it } from "vitest";
import { getSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { cleanupResidentSessions, residentSession } from "../../helpers/anthropic-subscription-held-model-switch.ts";

afterEach(() => cleanupResidentSessions());

describe("senpi#6411 anthropic-subscription set_model does not wait for Claude Code", () => {
	it("answers set_model while the live process is still confirming the model", async () => {
		const { harness, events, model, setModelCall } = await residentSession();

		await harness.session.setModel(model("claude-next"));
		events.push("set_model returned");

		expect(events).toEqual(["stream:claude-test", "submitted:1", "setModel:claude-next", "set_model returned"]);
		(await setModelCall(0)).release();
	}, 30_000);

	it("runs a prompt sent right after the switch on the new model, after the process confirmed it", async () => {
		const { harness, events, queries, process0, model, setModelCall, atAdmission } = await residentSession();
		const sessionId = harness.sessionManager.getSessionId();
		await harness.session.setModel(model("claude-next"));
		const pending = await setModelCall(0);

		atAdmission(() => pending.release());
		await harness.session.prompt("second");

		expect(events.slice(2)).toEqual([
			"setModel:claude-next",
			"stream:claude-next",
			"admission waits",
			"confirmed:claude-next",
			"submitted:2",
		]);
		expect(queries).toHaveLength(1);
		expect(process0.submitted).toHaveLength(2);
		expect(getSession(sessionId)?.modelId).toBe("claude-next");
	}, 30_000);

	it("reattaches the same lineage on the new model when the live switch fails, without an unhandled rejection", async () => {
		const { harness, events, queries, process0, model, setModelCall, atAdmission } = await residentSession();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await harness.session.setModel(model("claude-next"));
			const pending = await setModelCall(0);
			atAdmission(() => pending.fail(new Error("Couldn't confirm model claude-next with the API")));
			await harness.session.prompt("second");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
		expect(events.slice(2)).toEqual(["setModel:claude-next", "stream:claude-next", "admission waits", "submitted:2"]);
		expect(queries).toHaveLength(2);
		expect(process0.submitted).toHaveLength(1);
		expect(queries[1]?.options).toMatchObject({ resume: process0.options?.sessionId, model: "claude-next" });
		expect(queries[1]?.submitted).toHaveLength(1);
		expect(getSession(harness.sessionManager.getSessionId())?.modelId).toBe("claude-next");
	}, 30_000);

	it("applies two quick switches in order, the second only after the first settled", async () => {
		const { harness, events, queries, process0, model, setModelCall, atAdmission } = await residentSession();
		await harness.session.setModel(model("claude-next"));
		await harness.session.setModel(model("claude-third"));
		expect(events.slice(2)).toEqual(["setModel:claude-next"]);

		const first = await setModelCall(0);
		atAdmission(() => first.release());
		const prompted = harness.session.prompt("second");
		(await setModelCall(1)).release();
		await prompted;

		expect(events.slice(2)).toEqual([
			"setModel:claude-next",
			"stream:claude-third",
			"admission waits",
			"confirmed:claude-next",
			"setModel:claude-third",
			"confirmed:claude-third",
			"submitted:2",
		]);
		expect(queries).toHaveLength(1);
		expect(process0.submitted).toHaveLength(2);
		expect(getSession(harness.sessionManager.getSessionId())?.modelId).toBe("claude-third");
	}, 30_000);
});
