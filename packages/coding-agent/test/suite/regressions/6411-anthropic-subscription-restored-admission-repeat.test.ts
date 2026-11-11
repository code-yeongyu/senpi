/**
 * senpi#6412 review: when a model switch lands during turn admission, admission runs again. The restored-binding
 * check forgets a binding whose transcript it rejects, so a second run read no binding and reported the transcript as
 * available. The continuity decision must still see what the first run decided: the restored binding, with its
 * transcript missing.
 *
 * The second `set_model` is issued from inside the first restored-binding admission, so the repeat is fixed by the
 * call sequence and not by timing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as continuity from "../../../src/core/extensions/builtin/anthropic-subscription/session-continuity.ts";
import {
	getBinding,
	rememberBinding,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import * as restoredAdmission from "../../../src/core/extensions/builtin/anthropic-subscription/session-restored-admission.ts";
import { cleanupResidentSessions, residentSession } from "../../helpers/anthropic-subscription-held-model-switch.ts";

afterEach(() => {
	vi.restoreAllMocks();
	cleanupResidentSessions();
});

describe("senpi#6412 a repeated turn admission", () => {
	it("keeps the restored binding the first admission rejected", async () => {
		const { harness, events, model, setModelCall, atAdmission } = await residentSession();
		const sessionId = harness.sessionManager.getSessionId();
		const served = getBinding(sessionId);
		if (!served) throw new Error("the first turn recorded no binding");
		// A binding restored from the session file carries the persisted prefix hash, so admission checks its transcript.
		rememberBinding({ ...served, sentPrefixHash: "restored-prefix" });

		await harness.session.setModel(model("claude-next"));
		const first = await setModelCall(0);
		atAdmission(() => first.release());

		const admit = restoredAdmission.admitRestoredBinding;
		vi.spyOn(restoredAdmission, "admitRestoredBinding").mockImplementationOnce(async (...args) => {
			await harness.session.setModel(model("claude-third"));
			atAdmission(() => void setModelCall(1).then((second) => second.release()));
			return admit(...args);
		});
		const decide = vi.spyOn(continuity, "decideNativeContinuity");
		await harness.session.prompt("second");

		expect(events.filter((event) => event === "admission waits")).toHaveLength(2);
		expect(decide).toHaveBeenCalledTimes(1);
		const [input] = decide.mock.calls[0] ?? [];
		expect({ sdkSessionId: input?.binding?.sdkSessionId, transcriptAvailable: input?.transcriptAvailable }).toEqual({
			sdkSessionId: served.sdkSessionId,
			transcriptAvailable: false,
		});
	}, 30_000);
});
