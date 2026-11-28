import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7628: an unattended resume folds a run of held peer deliveries from one speaker into one turn (senpi#7588). The
// turn's entry settles every delivery it carries, and it records the highest thread-chain hop among them.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

function heldNoticeWritten(h: Harness): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "session_notice" || event.disposition !== "notice_persisted") return;
			unsubscribe();
			resolve();
		});
	});
}

/** A session whose person's Stop kept `chainCounts.length` peer deliveries from one speaker as held notices. */
async function stoppedWithHeldDeliveries(
	chainCounts: readonly (number | undefined)[],
	options: { readonly unattended?: boolean } = {},
) {
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.setResponses([fauxAssistantMessage([fauxText("read them")])]);
	const hold = h.session["_engineTurnHold"];
	if (options.unattended === true) hold.addHold("unattended");
	hold.addHold("session_hold", { key: "session_hold:1", data: { localSeq: 1 } });
	const ids: string[] = [];
	for (const [index, chainCount] of chainCounts.entries()) {
		const delivery_id = `fold-${index + 1}`;
		ids.push(delivery_id);
		const input = { delivery_id, text: `payload-${index + 1}`, deliverAs: "followUp" } as const;
		const written = heldNoticeWritten(h);
		expect(h.session.externalAdmission.admit(input, chainCount === undefined ? {} : { chainCount }).kind).toBe(
			"held",
		);
		await written;
	}
	return { h, ids };
}

/** Lifting the Stop leaves the unattended hold, whose resume is the one that folds the run. */
async function unattendedWithHeldDeliveries(chainCounts: readonly (number | undefined)[]) {
	const held = await stoppedWithHeldDeliveries(chainCounts, { unattended: true });
	held.h.session["_engineTurnHold"].release(["session_hold:1"], "resume_session");
	return held;
}

function deliveryEntries(h: Harness) {
	return h.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE ? [entry] : [],
		);
}

it("settles every delivery a folded turn carries as emitted, once each", async () => {
	const { h, ids } = await unattendedWithHeldDeliveries([undefined, undefined, undefined]);
	const emitted: string[] = [];
	h.session.externalAdmission.onEmitted((id) => emitted.push(id));

	expect(await h.session.resumeSessionRequest({})).toMatchObject({ resumed: true, turnStarted: true });

	expect(h.faux.state.callCount).toBe(1);
	expect(deliveryEntries(h)).toHaveLength(1);
	expect(h.session.externalAdmission.list()).toEqual({ pending: [], emitted: ids });
	expect(emitted).toEqual(ids);
});

// A person's Resume after a Stop carries the held deliveries inside its one resume message: that entry settles them.
it("settles every held delivery a Resume after a Stop carries in its one message", async () => {
	const { h, ids } = await stoppedWithHeldDeliveries([undefined, undefined]);
	const emitted: string[] = [];
	h.session.externalAdmission.onEmitted((id) => emitted.push(id));

	expect(await h.session.resumeSessionRequest({})).toMatchObject({ resumed: true, turnStarted: true });

	expect(h.faux.state.callCount).toBe(1);
	expect(deliveryEntries(h)).toEqual([]);
	expect(h.session.externalAdmission.list()).toEqual({ pending: [], emitted: ids });
	expect(emitted).toEqual(ids);
});

it("records the highest thread-chain hop of a folded run, wherever it sits in the run", async () => {
	const { h } = await unattendedWithHeldDeliveries([1, 3, 2]);

	await h.session.resumeSessionRequest({});

	const [entry, ...rest] = deliveryEntries(h);
	expect(rest).toEqual([]);
	expect(entry?.details).toMatchObject({ delivery_id: "fold-1", chain_count: 3 });
});
