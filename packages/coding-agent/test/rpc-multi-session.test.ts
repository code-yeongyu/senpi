import { describe, expect, test } from "vitest";
import {
	RPC_ERROR_MISSING_SESSION_ID,
	RPC_ERROR_MULTI_SESSION_DISABLED,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_UNKNOWN_SESSION,
} from "../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";

function routerFor(state: "open" | "closing" = "open") {
	const registry = {
		list: () => [],
		getForCommand: (id: string) => {
			if (id !== "known") throw Object.assign(new Error("unknown_session"), { code: "unknown_session" });
			if (state === "closing") throw Object.assign(new Error("session_closing"), { code: "session_closing" });
			return { state, runtime: {} };
		},
		close: async () => {},
	} as never;
	return new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: "/tmp" });
}

describe("multi-session RPC routing", () => {
	test("requires a routing session id for established commands", async () => {
		const response = await routerFor().handle({ id: "p", type: "prompt", message: "hello" });
		expect(response).toMatchObject({ success: false, error: RPC_ERROR_MISSING_SESSION_ID });
	});

	test("reports unknown and closing session handles with stable codes", async () => {
		expect(await routerFor().handle({ id: "p", type: "prompt", message: "hello", sessionId: "gone" })).toMatchObject({
			error: RPC_ERROR_UNKNOWN_SESSION,
		});
		expect(
			await routerFor("closing").handle({ id: "p", type: "prompt", message: "hello", sessionId: "known" }),
		).toMatchObject({ error: RPC_ERROR_SESSION_CLOSING });
	});

	test("advertises multi-session capability before any session is opened", async () => {
		expect(await routerFor().handle({ id: "probe", type: "get_protocol_info" })).toEqual({
			id: "probe",
			type: "response",
			command: "get_protocol_info",
			success: true,
			data: { protocolVersion: 1, capabilities: ["multi_session"], mode: "multi" },
		});
	});

	test("keeps the classic-only open error code stable", () => {
		expect(RPC_ERROR_MULTI_SESSION_DISABLED).toBe("multi_session_disabled");
	});
});
