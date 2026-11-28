import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { MAX_HELD_PEER_DELIVERIES } from "../../../src/core/engine-turn-hold-notices.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { admitExternalMessage } from "../../../src/modes/rpc/admit-external-message-command.ts";
import type { RpcAdmitExternalMessageCommand } from "../../../src/modes/rpc/admit-external-message-wire.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#7588 review: every held peer delivery is kept, so the number a paused session holds is bounded. Past the cap the
// delivery is refused with a typed answer and nothing is written: the sender keeps it. senpi#7628: the count is the real
// held set (a delivery an older log recorded twice is one), and the cap bounds every entry point, extensions included.
const LOCAL = { origin: undefined, connectionOrigin: "local" } as const;
const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

const record = (n: number): RpcAdmitExternalMessageCommand => ({
	type: "admit_external_message",
	deliveryId: `d-${n}`,
	text: `peer text ${n}`,
	sender: { kind: "agent", session_id: "sender" },
	deliverAs: "followUp",
});

/** A session held by a person's Stop, so every peer delivery is kept as a held notice. */
async function stopped(extensionFactories: ((pi: ExtensionAPI) => void)[] = []) {
	const fixture = await createIdentityHarness({ extensionFactories });
	fixtures.push(fixture);
	fixture.harness.setResponses([fauxAssistantMessage("done")]);
	fixture.bind();
	fixture.session["_engineTurnHold"].addHold("session_hold", { key: "session_hold:1", data: { localSeq: 1 } });
	return fixture;
}

/** Resolves once `count` more held notices are written: a held delivery's notice is written after an await. */
function heldNoticesWritten(session: AgentSession, count: number): Promise<void> {
	let seen = 0;
	return new Promise((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "session_notice" || event.disposition !== "notice_persisted" || ++seen < count) return;
			unsubscribe();
			resolve();
		});
	});
}

async function admitHeld(session: AgentSession, n: number): Promise<void> {
	const written = heldNoticesWritten(session, 1);
	expect(admitExternalMessage(session, record(n), LOCAL)).toMatchObject({ ok: true, data: { kind: "held" } });
	await written;
}

it("counts the real held set, a delivery recorded twice once, and refuses the next one past the cap", async () => {
	const fixture = await stopped();
	for (let n = 1; n < MAX_HELD_PEER_DELIVERIES; n++) await admitHeld(fixture.session, n);
	// An older log may hold one delivery twice (a resend after a restart was admitted again): replay such a log.
	const entries = fixture.session.sessionManager.getEntries();
	const first = entries.find((entry) => entry.type === "custom" && entry.customType === "session-notice");
	if (first?.type !== "custom") throw new Error("the first held delivery wrote no notice");
	fixture.session.sessionManager.appendCustomEntry("session-notice", {
		...(first.data as Record<string, unknown>),
		noticeId: "replayed-duplicate",
	});
	const session = await fixture.openSettled();
	expect(session.paused).toBe(true);
	expect(session.heldPeerDeliveryCount).toBe(MAX_HELD_PEER_DELIVERIES - 1);

	await admitHeld(session, MAX_HELD_PEER_DELIVERIES);
	const notices = session.pausedNoticeCount;
	expect(admitExternalMessage(session, record(MAX_HELD_PEER_DELIVERIES + 1), LOCAL)).toMatchObject({
		ok: false,
		refusal: { errorCode: "held_deliveries_full" },
	});
	expect(session.pausedNoticeCount).toBe(notices);
	expect(session.externalAdmission.list().pending).not.toContain(`rpc:local/d-${MAX_HELD_PEER_DELIVERIES + 1}`);
	expect(admitExternalMessage(session, record(1), LOCAL)).toMatchObject({
		ok: true,
		data: { kind: "already_admitted" },
	});
});

// An inbox drain admits what it finds in one pass: every delivery of the burst is held and counted before any of their
// notices is written, so the cap holds for a burst too.
it("refuses an extension's admission past the cap too, in one burst, writing nothing", async () => {
	let pi: ExtensionAPI | undefined;
	const fixture = await stopped([
		(api) => {
			pi = api;
		},
	]);
	if (pi === undefined) throw new Error("the extension did not load");
	const admit = (n: number) =>
		pi?.session.admitExternalMessage({ delivery_id: `ext-${n}`, text: `peer text ${n}`, deliverAs: "followUp" });
	const written = heldNoticesWritten(fixture.session, MAX_HELD_PEER_DELIVERIES);
	const kinds = Array.from({ length: MAX_HELD_PEER_DELIVERIES + 1 }, (_, index) => admit(index + 1)?.kind);

	expect(kinds).toEqual([...Array(MAX_HELD_PEER_DELIVERIES).fill("held"), "held_deliveries_full"]);
	await written;
	expect(fixture.session.pausedNoticeCount).toBe(MAX_HELD_PEER_DELIVERIES);
	expect(fixture.session.heldPeerDeliveryCount).toBe(MAX_HELD_PEER_DELIVERIES);
	expect(fixture.session.externalAdmission.list().pending).not.toContain(`ext-${MAX_HELD_PEER_DELIVERIES + 1}`);
	expect(admit(1)?.kind).toBe("already_admitted");
});
