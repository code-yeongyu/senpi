import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { lifecycleDeliveryEntries } from "../../../src/core/lifecycle-delivery.ts";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { createBoundLifecycleHarness } from "../lifecycle-test-harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// Part of #4272: resolving the hint before publication must preserve the old persistence catch boundary.
it("C2.3 a lifecycle hint read failure still publishes its terminal and correlated refusal", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const h = await createBoundLifecycleHarness({ persistSession: true });
	try {
		const ticket = h.session.workObligations.open("task:hint", "children").transfer("omo-wake-queue:hint").ticket();
		const reduce = h.sessionManager.reduceHistory.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "reduceHistory").mockImplementation((reducer) => {
			if (reducer === lifecycleDeliveryEntries) throw new Error("delivery history read refused");
			return reduce(reducer);
		});
		h.setResponses([fauxAssistantMessage("done")]);
		await Promise.allSettled([
			h.session.sendCustomMessage(
				{ customType: "senpi-task.completion", content: "preserve this result", display: false },
				{ triggerTurn: true, ticket },
			),
		]);
		const end = h.events.find(
			(event) =>
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.content === "preserve this result",
		);
		expect(end, "the terminal precedes any persistence refusal").toBeDefined();
		const failed = h.events.find(
			(event) => event.type === "transcript_write_failed" && event.errorMessage === "delivery history read refused",
		);
		expect(failed).toBeDefined();
		if (!end || !failed) throw new Error("missing terminal or refusal");
		expect(recoveryCarrier(failed)).toEqual(recoveryCarrier(end));
		expect(h.events.indexOf(end)).toBeLessThan(h.events.indexOf(failed));
	} finally {
		h.cleanup();
	}
}, 30000);
