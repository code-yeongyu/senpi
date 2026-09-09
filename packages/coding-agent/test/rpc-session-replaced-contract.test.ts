/**
 * Client-side contract for the session replacement event.
 *
 * `session_replaced` is the only push channel carrying the identity of a session
 * that was swapped behind an attached connection, so a typed client has to be
 * able to discriminate it off `RpcClientEvent` and read `durableSessionId`
 * without casting. These pins are as much a typecheck as a runtime assertion:
 * the discrimination below does not compile while the event is missing from the
 * union.
 */

import { describe, expect, it } from "vitest";
import type { RpcClientEvent } from "../src/modes/rpc/rpc-client.ts";
import type { RpcSessionReplacedEvent } from "../src/modes/rpc/rpc-types.ts";

describe("session_replaced client contract", () => {
	it("is a member of the RpcClientEvent union", () => {
		const replaced: RpcSessionReplacedEvent = {
			type: "session_replaced",
			durableSessionId: "01a05196-f9b3-7367-adb6-9b3136ef1582",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp",
			sessionName: "replacement",
		};

		// Fails to compile when the event is absent from the union, which is the
		// state this pin exists to prevent.
		const event: RpcClientEvent = replaced;

		expect(event.type).toBe("session_replaced");
	});

	it("narrows to the replacement identity on the type discriminant", () => {
		const events: RpcClientEvent[] = [
			{ type: "bash_start" },
			{
				type: "session_replaced",
				durableSessionId: "durable-1",
				cwd: "/workspace",
			},
		];

		const identities: string[] = [];
		for (const event of events) {
			// No cast: `durableSessionId` has to be reachable through the discriminant
			// alone, otherwise a typed client cannot resync after a replacement it did
			// not issue.
			if (event.type === "session_replaced") identities.push(event.durableSessionId);
		}

		expect(identities).toEqual(["durable-1"]);
	});
});
