import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ClientMessageEvents } from "../../../src/modes/rpc/client-message-events.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

// Part of #4272, delta LOW-1: turn correlation is not the identity of an extension's own input.
it("keeps a standing client correlation across identity-less user input within the same turn", () => {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	const seen: Array<{
		readonly record: object;
		readonly ref: ReturnType<SessionAcceptanceLane["accept"]>;
		readonly correlation: ReturnType<SessionAcceptanceLane["freeze"]>["correlation"];
	}> = [];
	const events = new ClientMessageEvents(
		(record) => {
			const ref = lane.accept(record, undefined);
			const root = lane.freeze();
			lane.release(root);
			seen.push({ record, ref, correlation: root.correlation });
		},
		() => true,
	);
	const client = { role: "user", content: "question", timestamp: 1, clientMessageId: "c-1" } as const;
	const steer = { role: "user", content: "extension steer", timestamp: 2 } as const;
	const assistant = fauxAssistantMessage("answer", { timestamp: 3 });
	events.accept({ type: "turn_start" });
	events.accept({ type: "message_start", message: client });
	const standing = seen[0]?.correlation;
	const turnId = seen[0]?.ref?.turnId;
	expect(standing).toMatchObject({ clientMessageId: "c-1" });
	expect(turnId).toEqual(expect.any(String));

	events.accept({ type: "message_start", message: steer });
	events.accept({ type: "message_end", message: steer });
	events.accept({ type: "message_start", message: assistant });
	const after = lane.freeze();
	lane.release(after);

	const ownRecord = seen.find(({ record }) => "message" in record && record.message === steer)?.record;
	expect(ownRecord).toBeDefined();
	expect(ownRecord).not.toHaveProperty("clientMessageId");
	expect(ownRecord).not.toHaveProperty("clientTurnId");
	expect(ownRecord).not.toHaveProperty("clientMessages");
	expect(steer).not.toHaveProperty("clientMessageId");
	expect(steer).not.toHaveProperty("clientTurnId");
	for (const [index, item] of seen.entries()) {
		expect(item.ref?.turnId).toBe(turnId);
		expect(item.correlation, "no END or restart inside this turn").toBe(standing);
		expect(item.ref?.sequence).toBe(index + 2);
	}
	expect(after.turnId).toBe(turnId);
	expect(after.correlation).toBe(standing);
	expect(after.sequence).toBe(seen.length + 1);
});

// Part of #4272, delta LOW-2: field-wise equality must still sequence changed ordered client identities.
it.each([
	{ clientMessages: [{ clientMessageId: "c-1" }] },
	{ clientMessages: [{ clientMessageId: "c-2" }, { clientMessageId: "c-1" }] },
	{ clientMessages: [{ clientMessageId: "c-1" }, { clientMessageId: "c-3" }] },
	{ clientMessages: [{ clientMessageId: "c-1" }, { clientMessageId: "c-2", clientTurnId: "t-2" }] },
])("sequences a changed clientMessages list without relying on serialized equality: %j", ({ clientMessages }) => {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	lane.accept(
		{
			type: "turn_start",
			clientMessageId: "c-2",
			clientMessages: [{ clientMessageId: "c-1" }, { clientMessageId: "c-2" }],
		},
		undefined,
	);
	const before = lane.freeze();
	lane.release(before);

	const accepted = lane.accept({ type: "message_update", clientMessageId: "c-2", clientMessages }, undefined);
	const after = lane.freeze();
	lane.release(after);
	expect(accepted?.sequence).toBe(before.sequence + 2);
	expect(after.correlation?.sequence).toBe(before.sequence + 1);
	expect(after.correlation?.clientMessages).toBe(clientMessages);
});
