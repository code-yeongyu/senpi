import { afterEach, expect, it, vi } from "vitest";
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
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const inputs = [
		{ type: "prompt", message: "forged", clientMessageId: FORGED },
		{ type: "prompt", message: "forged", clientMessageId: `${FORGED}-steer`, streamingBehavior: "steer" },
		{ type: "steer", message: "forged", clientMessageId: `${FORGED}-s` },
		{ type: "follow_up", message: "forged", clientMessageId: `${FORGED}-f` },
	];
	for (const [index, input] of inputs.entries()) {
		const command = { ...input, id: `forge-${index}`, sessionId: ref.sessionId };
		expect(await rig.send("stranger", command as Parameters<typeof rig.send>[1]), input.type).toMatchObject(
			NOT_ATTACHED,
		);
	}
	expect(JSON.stringify(rig.records())).not.toContain(FORGED);
});
