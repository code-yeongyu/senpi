import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
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

function publishedOwnDeliveryWaits(h: Harness): string[] {
	return h.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== "session-lifecycle") return [];
		const data = entry.data as { waitingOn?: { background?: readonly { source: string }[] } } | undefined;
		return (data?.waitingOn?.background ?? [])
			.map((wait) => wait.source)
			.filter((source) => source.startsWith(ENGINE_DELIVERY_KEY_PREFIX));
	});
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

	// senpi#6814 review M1: once the delivery's turn has consumed it, its custody stays open until the run settles; ending
	// the delivery must not publish a lifecycle record that names that custody as background work again.
	it("never publishes a lifecycle record naming the delivery's own custody as background, in flight or after its turn", async () => {
		const h = await createBoundLifecycleHarness({ persistSession: true });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("ack")]);

		const idle = nextSessionEvent(h, (event) => event.type === "agent_idle");
		h.session.externalAdmission.admit({ delivery_id: "d1", text: "peer", deliverAs: "followUp" });
		await idle;

		expect(writtenDeliveries(h)).toEqual(["d1"]);
		expect(publishedOwnDeliveryWaits(h)).toEqual([]);
		expect(h.session.lifecycle.state).toBe("done");
	});

	// senpi#6814 review L3: between the delivery's end and its run settling, anything else that publishes (here a wake
	// source changing while the session reports idle) must not name the consumed delivery custody as background work.
	it("never names the consumed delivery custody as background when another source publishes before the run settles", async () => {
		let events: ExtensionAPI["events"] | undefined;
		const h = await createBoundLifecycleHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					events = pi.events;
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("ack")]);
		const ownDeliveryCustody = `${ENGINE_DELIVERY_KEY_PREFIX}${SESSION_CONTROL_DELIVERY_TYPE}:d1`;
		let custodyAtPublish: { key: string; state: string }[] = [];
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			custodyAtPublish = h.session.workObligations.active.map(({ key, state }) => ({ key, state }));
			events?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitor", activeCount: 1 });
			events?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitor", activeCount: 0 });
		});

		const idle = nextSessionEvent(h, (event) => event.type === "agent_idle");
		h.session.externalAdmission.admit({ delivery_id: "d1", text: "peer", deliverAs: "followUp" });
		await idle;
		unsubscribe();

		// The publish landed inside the window: the delivery had ended and its custody was consumed but not yet settled.
		expect(custodyAtPublish).toEqual([{ key: ownDeliveryCustody, state: "consumed" }]);
		expect(writtenDeliveries(h)).toEqual(["d1"]);
		expect(publishedOwnDeliveryWaits(h)).toEqual([]);
		expect(h.session.workObligations.active).toEqual([]);
		expect(h.session.lifecycle.state).toBe("done");
	});

	// A guard, not a #6810 regression proof (it passes on the pre-fix code too): counting the in-flight start as running
	// must never strand a delivery admitted behind it (it joins that start, omo#14972).
	it("writes a delivery admitted behind the in-flight delivery start before the session goes idle", async () => {
		const gate = holdFirstTurnStart();
		const h = await createBoundLifecycleHarness({ persistSession: true, extensionFactories: [gate.extension] });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("ack d1"), fauxAssistantMessage("ack d2")]);

		h.session.externalAdmission.admit({ delivery_id: "d1", text: "first", deliverAs: "followUp" });
		await gate.entered;
		const joined = h.session.externalAdmission.admit({ delivery_id: "d2", text: "second", deliverAs: "followUp" });
		expect(joined.kind).toBe("steered");

		const idle = nextSessionEvent(h, (event) => event.type === "agent_idle");
		gate.release();
		await idle;

		expect(writtenDeliveries(h)).toEqual(["d1", "d2"]);
		expect(h.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["d1", "d2"] });
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect(h.session.lifecycle.state).toBe("done");
	});
});
