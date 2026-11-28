import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_HELD_PEER_DELIVERIES } from "../../../src/core/engine-turn-hold-notices.ts";
import { admitExternalMessage } from "../../../src/modes/rpc/admit-external-message-command.ts";
import type { RpcAdmitExternalMessageCommand } from "../../../src/modes/rpc/admit-external-message-wire.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#7588 review: every held peer delivery is now kept, so the number a paused session holds is bounded. Past the
// cap the delivery is refused with a typed code and nothing is written: the sender keeps it.
const LOCAL = { origin: undefined, connectionOrigin: "local" } as const;
const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

const record = (deliveryId: string): RpcAdmitExternalMessageCommand => ({
	type: "admit_external_message",
	deliveryId,
	text: "peer text",
	deliverAs: "followUp",
	whenIdle: "queue",
});

async function session(held: number) {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	fixture.harness.setResponses([fauxAssistantMessage("done")]);
	vi.spyOn(fixture.session, "heldPeerDeliveryCount", "get").mockReturnValue(held);
	return fixture.session;
}

it("refuses a new delivery once the session holds the cap, writing nothing", async () => {
	const s = await session(MAX_HELD_PEER_DELIVERIES);
	expect(admitExternalMessage(s, record("d-new"), LOCAL)).toMatchObject({
		ok: false,
		refusal: { errorCode: "held_deliveries_full" },
	});
	expect(s.externalAdmission.list().pending).toEqual([]);
	expect(s.agent.peekQueuedMessages({ all: true })).toEqual([]);
});

it("admits below the cap, and answers an already admitted id at the cap as admitted", async () => {
	const s = await session(MAX_HELD_PEER_DELIVERIES - 1);
	expect(admitExternalMessage(s, record("d-1"), LOCAL)).toMatchObject({ ok: true, data: { kind: "queued" } });
	vi.spyOn(s, "heldPeerDeliveryCount", "get").mockReturnValue(MAX_HELD_PEER_DELIVERIES);
	expect(admitExternalMessage(s, record("d-1"), LOCAL)).toMatchObject({
		ok: true,
		data: { kind: "already_admitted" },
	});
});
