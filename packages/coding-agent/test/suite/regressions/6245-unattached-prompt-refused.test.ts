import { afterEach, expect, it, vi } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { attachmentRig } from "../rpc-attachment-support.ts";

// senpi#6245: an unattached connection cannot put input into a session, however its clientMessageId is chosen. The
// id carries a reply route downstream (omo#12863), so the input never reaches the session, its queue or its log.
afterEach(() => {
	vi.unstubAllEnvs();
});

const FORGED = "route:forged-reply-target";
const NOT_ATTACHED = {
	success: false,
	errorCode: "session_not_attached",
	errorData: {
		reason: "this connection is not attached to that session",
		action: "attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }",
	},
};

it.each([
	["no switch set", undefined],
	["the retired grace switch set to 0", "0"],
] as const)("refuses an unattached prompt carrying a chosen clientMessageId (%s)", async (_label, flag) => {
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", flag);
	// The session's worker binding: a command the gate let through is routed here, clientMessageId and all.
	const routed: RpcCommand[] = [];
	await using rig = await attachmentRig(async (command) => {
		routed.push(command);
	});
	const ref = await rig.session();
	const inputs = [
		{ type: "prompt", message: "forged", clientMessageId: FORGED },
		{ type: "prompt", message: "forged", clientMessageId: `${FORGED}-steer`, streamingBehavior: "steer" },
		{ type: "steer", message: "forged", clientMessageId: `${FORGED}-s` },
		{ type: "follow_up", message: "forged", clientMessageId: `${FORGED}-f` },
	];
	const replies: Awaited<ReturnType<typeof rig.send>>[] = [];
	for (const [index, input] of inputs.entries()) {
		const command = { ...input, id: `forge-${index}`, sessionId: ref.sessionId };
		replies.push(await rig.send("stranger", command as Parameters<typeof rig.send>[1]));
	}
	expect(routed.map((command) => command.type)).toEqual([]);
	for (const [index, input] of inputs.entries()) expect(replies[index], input.type).toMatchObject(NOT_ATTACHED);
});
