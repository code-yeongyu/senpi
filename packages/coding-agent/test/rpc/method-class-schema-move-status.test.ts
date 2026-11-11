/**
 * The inbound schema of `move_session` op `status` accepts the `landing` a validated caller sends (the place a move
 * would have landed) and keeps its fields bounded. What a landing may name is the host's own parse to refuse.
 */
import { describe, expect, it } from "vitest";
import {
	RPC_INBOUND_LIMITS,
	type RpcInboundValidation,
	validateRpcInboundRecord,
} from "../../src/modes/rpc/method-classes-schema.ts";

const ACCEPTED: RpcInboundValidation = { ok: true };
const refused = (record: unknown): string => {
	const result = validateRpcInboundRecord(record);
	if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(record).slice(0, 80)}`);
	return result.reason;
};

const status = (fields: object) => ({ type: "move_session", op: "status", moveId: "m", ...fields });
const landing = { cwd: "/repo", sessionFileName: "2026-10-19T00-00-00-000Z_session.jsonl" };

describe("move_session status inbound schema: landing", () => {
	it("accepts a status with a landing, with and without the session folder", () => {
		for (const record of [status({}), status({ landing }), status({ landing: { ...landing, sessionDir: "/sessions" } })])
			expect(validateRpcInboundRecord(record)).toEqual(ACCEPTED);
	});

	it("refuses a landing that is not an object of its fields, and fields past their bounds", () => {
		for (const record of [
			status({ landing: "here" }),
			status({ landing: { cwd: "/repo" } }),
			status({ landing: { ...landing, cwd: 7 } }),
			status({ landing: { ...landing, sessionFileName: "x".repeat(RPC_INBOUND_LIMITS.identifierCharacters + 1) } }),
			status({ landing: { ...landing, sessionDir: "/".repeat(RPC_INBOUND_LIMITS.pathCharacters + 1) } }),
		])
			expect(refused(record)).toContain("does not match its schema");
	});
});
