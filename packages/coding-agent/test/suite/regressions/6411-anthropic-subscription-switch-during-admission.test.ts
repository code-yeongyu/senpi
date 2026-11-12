/**
 * senpi#6411 review of #6412: a model switch issued while a turn is being admitted, after it waited for the earlier
 * switch, must settle before the turn is submitted. Otherwise the turn runs on the live process while that process
 * is still switching models.
 *
 * The second `set_model` is issued from inside the restored-binding admission, the await that follows the wait for
 * the first switch, so the ordering is fixed by the call sequence and not by timing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as restoredAdmission from "../../../src/core/extensions/builtin/anthropic-subscription/session-restored-admission.ts";
import { cleanupResidentSessions, residentSession } from "../../helpers/anthropic-subscription-held-model-switch.ts";

afterEach(() => {
	vi.restoreAllMocks();
	cleanupResidentSessions();
});

describe("senpi#6411 a switch issued during turn admission", () => {
	it("is confirmed before the turn is submitted, never while the turn runs", async () => {
		const { harness, events, model, setModelCall, atAdmission } = await residentSession();
		await harness.session.setModel(model("claude-next"));
		const first = await setModelCall(0);
		atAdmission(() => first.release());

		const admit = restoredAdmission.admitRestoredBinding;
		vi.spyOn(restoredAdmission, "admitRestoredBinding").mockImplementationOnce(async (...args) => {
			events.push("admitting");
			await harness.session.setModel(model("claude-third"));
			atAdmission(() => void setModelCall(1).then((second) => second.release()));
			return admit(...args);
		});
		await harness.session.prompt("second");

		expect(events.slice(2)).toEqual([
			"setModel:claude-next",
			"stream:claude-next",
			"admission waits",
			"confirmed:claude-next",
			"admitting",
			"setModel:claude-third",
			"admission waits",
			"confirmed:claude-third",
			"submitted:2",
		]);
	}, 30_000);
});
