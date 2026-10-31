import { expect, it } from "vitest";
import type { RecoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { type CallsRig, callsRig } from "./4272-calls-support.ts";
import { produced } from "./4272-catalog-read-support.ts";

// Part of #4272 (S10b, R4.B2, #4568 review LOW 3): a settled terminal's and an entry join's member id are stable
// ordinals, like the active, calls and source members: a member keeps its id from one cut to the next while earlier
// terminals settle or later joins arrive.

function pendingTerminal(rig: CallsRig, id: string): RecoveryCarrier {
	rig.record({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} });
	rig.record({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: "r", isError: false });
	return rig.toolResult(id, "read", "done");
}

function join(rig: CallsRig, carrier: RecoveryCarrier, entryId: string): void {
	rig.lane.applyTranscript([
		{
			kind: "append",
			id: entryId,
			type: "message",
			parentId: null,
			owningMessageId: carrier.messageId,
			recoveryEpoch: carrier.epoch,
		},
	]);
}

/** The member ids of `family` in a fresh cut, keyed by the `messageId` field of each member's value. */
async function membersByMessage(rig: CallsRig, family: string): Promise<Map<string, string>> {
	await rig.lane.idle();
	const root = rig.lane.freeze();
	try {
		const { texts } = await produced(rig.lane, root);
		const members = new Map<string, string>();
		for (const [key, text] of texts) {
			if (!key.startsWith(`${family}/`) || text === "") continue;
			const messageId: unknown = Reflect.get(Object(JSON.parse(text)), "messageId");
			if (typeof messageId === "string") members.set(messageId, key);
		}
		return members;
	} finally {
		rig.lane.release(root);
	}
}

it("#4568 LOW 3 pending terminals keep their settled member ids when the terminal enumerated first settles between two cuts", async () => {
	// Given: five pending toolResult terminals
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const carriers = Array.from({ length: 5 }, (_, index) => pendingTerminal(rig, `c${index}`));
		const before = await membersByMessage(rig, "settled");
		expect(before.size).toBe(5);
		// When: the terminal the cut enumerates first joins its entry and leaves the settled family
		const [firstListed] = [...before].sort(([, a], [, b]) => a.localeCompare(b))[0] ?? expect.unreachable();
		join(rig, carriers.find((carrier) => carrier.messageId === firstListed) ?? expect.unreachable(), "e1");
		// Then: every other terminal's member id did not move
		before.delete(firstListed);
		expect(await membersByMessage(rig, "settled")).toEqual(before);
	} finally {
		await rig.close();
	}
});

it("#4568 LOW 3 an entry join keeps its identity member id when a later join sorts before it", async () => {
	// Given: ten terminals, so message ids of two digits sort before the one-digit ones, and the last one joined first
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const carriers = Array.from({ length: 10 }, (_, index) => pendingTerminal(rig, `c${index}`));
		const last = carriers[9] ?? expect.unreachable();
		join(rig, last, "e9");
		const before = (await membersByMessage(rig, "identity")).get(last.messageId);
		expect(before).toBeDefined();
		// When: every older message joins after it
		for (const [index, carrier] of carriers.slice(0, 9).entries()) join(rig, carrier, `e${index}`);
		// Then: the first join's member id did not move
		expect((await membersByMessage(rig, "identity")).get(last.messageId)).toBe(before);
	} finally {
		await rig.close();
	}
});
