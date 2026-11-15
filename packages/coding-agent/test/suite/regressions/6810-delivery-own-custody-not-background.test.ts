import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { ENGINE_DELIVERY_KEY_PREFIX } from "../../../src/core/work-obligations.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness, nextSessionEvent } from "../lifecycle-test-harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function holdFirstTurnStart() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held = false;
	const extension = (pi: ExtensionAPI) => {
		pi.on("before_agent_start", async (event) => {
			if (event.preview === true || held) return undefined;
			held = true;
			entered.resolve();
			await release.promise;
			return undefined;
		});
	};
	return { extension, entered: entered.promise, release: () => release.resolve() };
}

function ownDeliveryWaits(h: Harness): string[] {
	return (h.session.lifecycle.waitingOn?.background ?? [])
		.map((wait) => wait.source)
		.filter((source) => source.startsWith(ENGINE_DELIVERY_KEY_PREFIX));
}

function writtenDeliveries(h: Harness): string[] {
	return h.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE
				? [String((entry.details as { delivery_id?: unknown } | undefined)?.delivery_id)]
				: [],
		);
}

// senpi#6810 (reported downstream in code-yeongyu/oh-my-openagent#13716): a delivery's own engine custody is the
// session starting a turn for it, never background work the session waits on.
describe("a delivery never counts its own custody as background work (senpi#6810)", () => {
	it("reports running, not waiting_background, while the delivery's own turn start is in flight", async () => {
		const gate = holdFirstTurnStart();
		const h = await createBoundLifecycleHarness({ persistSession: true, extensionFactories: [gate.extension] });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("ack")]);

		const admitted = h.session.externalAdmission.admit({ delivery_id: "d1", text: "peer", deliverAs: "followUp" });
		await gate.entered;

		expect(admitted.kind).toBe("started");
		expect(h.session.workObligations.active.map((record) => record.key)).toEqual([
			`${ENGINE_DELIVERY_KEY_PREFIX}${SESSION_CONTROL_DELIVERY_TYPE}:d1`,
		]);
		expect(ownDeliveryWaits(h)).toEqual([]);
		expect(h.session.lifecycle.state).toBe("running");

		const idle = nextSessionEvent(h, (event) => event.type === "agent_idle");
		gate.release();
		await idle;
		expect(writtenDeliveries(h)).toEqual(["d1"]);
		expect(h.session.workObligations.active).toEqual([]);
		expect(h.session.lifecycle.state).toBe("done");
	});

	it("starts a follow-up queued behind the in-flight delivery start once the session goes idle", async () => {
		const gate = holdFirstTurnStart();
		const h = await createBoundLifecycleHarness({ persistSession: true, extensionFactories: [gate.extension] });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("ack d1"), fauxAssistantMessage("ack d2")]);

		h.session.externalAdmission.admit({ delivery_id: "d1", text: "first", deliverAs: "followUp" });
		await gate.entered;
		const queued = h.session.externalAdmission.admit({ delivery_id: "d2", text: "second", deliverAs: "followUp" });
		expect(queued.kind).toBe("queued");

		const idle = nextSessionEvent(h, (event) => event.type === "agent_idle");
		gate.release();
		await idle;

		expect(writtenDeliveries(h)).toEqual(["d1", "d2"]);
		expect(h.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["d1", "d2"] });
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect(h.session.lifecycle.state).toBe("done");
	});
});
