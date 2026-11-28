import { expect, it } from "vitest";
import { EngineTurnHold } from "../../../src/core/engine-turn-hold.ts";
import { EngineTurnRelease } from "../../../src/core/engine-turn-release.ts";
import {
	SESSION_CONTROL_DELIVERY_TYPE,
	type SessionControlDeliveryDetails,
} from "../../../src/core/extensions/session-control-types.ts";
import type { CustomMessage } from "../../../src/core/messages.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

// senpi#7588 review: a held peer delivery is replayed from its `session-notice` entry. An older log may hold one
// delivery twice (a resend after a restart was admitted again), and an unattended resume ran one turn per delivery.

const at = "2026-11-27T00:00:00.000Z";
let entryCount = 0;
const entry = (customType: string, data: unknown): SessionEntry => ({
	type: "custom",
	customType,
	data,
	id: `entry-${++entryCount}`,
	parentId: null,
	timestamp: at,
});

const delivery = (n: number, speaker: Partial<SessionControlDeliveryDetails> = {}): CustomMessage => ({
	role: "custom",
	customType: SESSION_CONTROL_DELIVERY_TYPE,
	content: `payload-${n}`,
	display: true,
	details: {
		delivery_id: `rpc:local/delivery-${n}`,
		source: "session_control",
		deliverAs: "followUp",
		sender: { kind: "agent", session_id: "sender" },
		...speaker,
	},
	timestamp: 0,
});

const held = (n: number, noticeId: string, speaker: Partial<SessionControlDeliveryDetails> = {}) =>
	entry("session-notice", {
		noticeId,
		producer: SESSION_CONTROL_DELIVERY_TYPE,
		pauseSeq: 1,
		at,
		heldCount: 1,
		text: "held",
		action: "resume_session",
		message: delivery(n, speaker),
	});

function replay(entries: SessionEntry[]) {
	const written: Array<{ type: string; data: unknown }> = [];
	const hold = new EngineTurnHold(
		[entry("session-hold", { op: "add", kind: "unattended", key: "unattended", pauseSeq: 1, at }), ...entries],
		true,
		(type, data) => {
			written.push({ type, data });
			return `written-${written.length}`;
		},
		() => {},
		() => {},
	);
	return { hold, written };
}

async function release(hold: EngineTurnHold) {
	const turns: string[][] = [];
	await new EngineTurnRelease().resume(
		hold,
		async (message, admit) => {
			const content =
				typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
			turns.push(content.flatMap((part) => (part.type === "text" ? [part.text] : [])));
			return admit();
		},
		async () => {},
	);
	return turns;
}

it("replays a held peer delivery written twice as one item and consumes both notices with it", async () => {
	const { hold, written } = replay([held(1, "notice-a"), held(2, "notice-b"), held(2, "notice-b-again")]);
	expect(hold.noticeCount).toBe(2);
	expect(hold.peerDeliveryIds).toEqual(["rpc:local/delivery-1", "rpc:local/delivery-2"]);
	expect(hold.messages().map(({ noticeIds }) => noticeIds)).toEqual([["notice-a"], ["notice-b", "notice-b-again"]]);
	expect((await release(hold)).flat()).toEqual(["payload-1", "payload-2"]);
	const consumed = written.flatMap(({ type, data }) =>
		type === "session-notices-consumed" && typeof data === "object" && data !== null && "noticeIds" in data
			? [data.noticeIds]
			: [],
	);
	expect(consumed.flat()).toEqual(["notice-a", "notice-b", "notice-b-again"]);
	expect(hold.noticeCount).toBe(0);
});

it("opens one turn for every held delivery of one speaker on an unattended resume, in admission order", async () => {
	const { hold } = replay([held(1, "notice-1"), held(2, "notice-2"), held(3, "notice-3")]);
	expect(await release(hold)).toEqual([["payload-1", "payload-2", "payload-3"]]);
	expect(hold.noticeCount).toBe(0);
});

it("keeps a delivery from another sender or another device in its own turn: one turn carries one origin", async () => {
	const { hold } = replay([
		held(1, "notice-1"),
		held(2, "notice-2"),
		held(3, "notice-3", { sender: { kind: "agent", session_id: "another-sender" } }),
		held(4, "notice-4", { remote_origin: { deviceId: "device-x" } }),
		held(5, "notice-5"),
	]);
	expect(await release(hold)).toEqual([["payload-1", "payload-2"], ["payload-3"], ["payload-4"], ["payload-5"]]);
	expect(hold.noticeCount).toBe(0);
});
