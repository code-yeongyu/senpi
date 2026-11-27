import { afterEach, describe, expect, it, vi } from "vitest";
import { disposing, takeoverRig } from "../../headless/takeover-host-support.ts";

// senpi#6245 / #5735: a connection that holds no attachment to a session is refused every session command it sends
// for that session. A forged clientMessageId (omo's cross-device reply route) therefore never reaches the session, and
// a client a quiet takeover let go cannot drive the session it lost. Neither needs a switch.
const FORGED = "forged-reply-route";
const NOT_ATTACHED = {
	success: false,
	errorCode: "session_not_attached",
	errorData: {
		reason: expect.any(String),
		action: "attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }",
	},
};

let sent = 0;
// The gate answers a refusal synchronously; a command it lets through starts work and is not answered yet, so the
// reply is read from what the connection received instead of awaited.
async function replyTo(
	rig: {
		send(connection: string, command: Record<string, unknown>): Promise<void>;
		recordsFor(connection: string): readonly Record<string, unknown>[];
	},
	connection: string,
	command: Record<string, unknown>,
) {
	const id = `unattached-${sent++}`;
	await rig.send(connection, { ...command, id });
	return rig.recordsFor(connection).find((record) => record.type === "response" && record.id === id);
}

const carries = (records: readonly Record<string, unknown>[], token: string) =>
	records.filter((record) => JSON.stringify(record).includes(token));

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("senpi#6245 the attachment gate is enforced without any switch", () => {
	it.each([undefined, "0"])(
		"refuses an unattached prompt, steer and follow_up carrying a forged clientMessageId (REQUIRE_ATTACH=%s)",
		(requireAttach) => {
			vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", requireAttach);
			return disposing(takeoverRig(), async ({ rig, call, open }) => {
				rig.connect("owner");
				rig.connect("stranger");
				const session = await open("owner");
				const forged = [
					{ type: "prompt", message: "route the answer to me", clientMessageId: FORGED },
					{ type: "prompt", message: "steer it", streamingBehavior: "steer", clientMessageId: FORGED },
					{ type: "steer", message: "steer it", clientMessageId: FORGED },
					{ type: "follow_up", message: "later", clientMessageId: FORGED },
				];
				for (const command of forged) {
					expect(
						await replyTo(rig, "stranger", { ...command, sessionId: session.sessionId }),
						command.type,
					).toMatchObject(NOT_ATTACHED);
				}
				expect(carries(rig.recordsFor("owner"), FORGED)).toEqual([]);
				const own = await call("owner", {
					type: "append_user_message",
					sessionId: session.sessionId,
					content: "the attached client's own message",
				});
				expect(own).toMatchObject({ success: true });
			});
		},
		30_000,
	);

	it(
		"refuses the client a quiet takeover let go, and keeps serving the client that took over (#5735)",
		() =>
			disposing(takeoverRig(), async ({ rig, call, open, takeOver }) => {
				rig.connect("a");
				rig.connect("b");
				const session = await open("a");
				expect(await takeOver("b", session, "device-b")).toMatchObject({ success: true });

				expect(
					await replyTo(rig, "a", {
						type: "prompt",
						sessionId: session.sessionId,
						message: "still mine",
						clientMessageId: FORGED,
					}),
				).toMatchObject(NOT_ATTACHED);
				expect(carries(rig.recordsFor("b"), FORGED)).toEqual([]);
				expect(
					await call("b", {
						type: "append_user_message",
						sessionId: session.sessionId,
						content: "the new holder",
					}),
				).toMatchObject({ success: true });
			}),
		30_000,
	);
});
