/**
 * senpi#6267: the inbound schema of `move_session` accepts the inline bundle fields a validated caller sends
 * (`inline`, `files`, `sessionDir`, `open`) and keeps the file list and its fields bounded.
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

describe("move_session inbound schema (senpi#6267)", () => {
	it("accepts a move's inline bundle fields and bounds the file list (senpi#6267)", () => {
		const file = { path: "manifest.json", sha256: "0".repeat(64), base64: "e30K" };
		const importing = (fields: object) => ({ type: "move_session", op: "import", cwd: "/repo", ...fields });
		const exporting = { type: "move_session", op: "export", sessionPath: "/s.jsonl", moveId: "m", target: "t" };
		for (const record of [
			importing({ files: Array.from({ length: RPC_INBOUND_LIMITS.listItems }, () => file) }),
			importing({ files: [file], sessionDir: "/sessions", open: true }),
			importing({ bundleDir: "/bundle", open: { retain_on_disconnect: true, kind: "interactive" } }),
			{ ...exporting, inline: true, inlineMaxBytes: 0 },
		])
			expect(validateRpcInboundRecord(record)).toEqual(ACCEPTED);
		for (const record of [
			importing({ files: Array.from({ length: RPC_INBOUND_LIMITS.listItems + 1 }, () => file) }),
			importing({ files: [{ ...file, sha256: "0".repeat(RPC_INBOUND_LIMITS.identifierCharacters + 1) }] }),
			importing({ files: [file], open: { retain_on_disconnect: "yes" } }),
			{ ...exporting, inline: true, inlineMaxBytes: -1 },
		])
			expect(refused(record)).toContain("does not match its schema");
	});
});
