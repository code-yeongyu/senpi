/**
 * senpi#4324: one bounded schema per inbound RPC record type, exhaustive over the method-class table, and a
 * validator that accepts every record a local client sends today (the X14 corpus).
 */
import Type from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { MAX_RPC_LINE_CHARACTERS } from "../../src/modes/rpc/jsonl.ts";
import { RPC_METHOD_CLASS } from "../../src/modes/rpc/method-classes.ts";
import {
	RPC_INBOUND_LIMITS,
	RPC_INBOUND_SCHEMAS,
	RPC_QUESTION_ANSWER_LIMITS,
	type RpcInboundSchemaDisagreements,
	type RpcInboundSchemaTable,
	type RpcInboundValidation,
	validateRpcInboundRecord,
} from "../../src/modes/rpc/method-classes-schema.ts";
import { sessionRetryFallbackError } from "../../src/modes/rpc/rpc-input-validation.ts";
import { sessionEnvShapeError } from "../../src/modes/rpc/session-caller-env.ts";
import { corpusRequest, NO_ID, TODAY } from "../characterization/rpc-method-surface-corpus.ts";

const ACCEPTED: RpcInboundValidation = { ok: true };
const refused = (record: unknown): string => {
	const result = validateRpcInboundRecord(record);
	if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(record).slice(0, 80)}`);
	return result.reason;
};
const image = { type: "image", data: "AAAA", mimeType: "image/png" };
const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));
const labels = (count: number) => Array.from({ length: count }, (_, i) => `label-${i}`);
const answers = (count: number, selected: number) =>
	Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, { selected: labels(selected) }]));
const envOf = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`NAME_${i}`, "v"]));
const acceptsTable = (table: RpcInboundSchemaTable): number => Object.keys(table).length;

describe("inbound record schemas are exhaustive (senpi#4324)", () => {
	it("has exactly one schema per method-class table entry", () => {
		expect(Object.keys(RPC_INBOUND_SCHEMAS).sort()).toEqual(Object.keys(RPC_METHOD_CLASS).sort());
	});

	it("fails the typecheck when a type has no schema or a schema misses a field", () => {
		const { open_session: _omitted, ...withoutOpenSession } = RPC_INBOUND_SCHEMAS;
		// @ts-expect-error -- open_session has no schema, so the table is not exhaustive
		expect(acceptsTable(withoutOpenSession)).toBe(Object.keys(RPC_METHOD_CLASS).length - 1);
		expectTypeOf<RpcInboundSchemaDisagreements<typeof RPC_INBOUND_SCHEMAS>>().toEqualTypeOf<never>();
		const { env: _env, ...openWithoutEnv } = RPC_INBOUND_SCHEMAS.open_session.properties;
		const stale = { ...RPC_INBOUND_SCHEMAS, open_session: Type.Object(openWithoutEnv) };
		expectTypeOf<RpcInboundSchemaDisagreements<typeof stale>>().toEqualTypeOf<"open_session">();
	});
});

describe("inbound record bounds (senpi#4324)", () => {
	it("refuses each bound class past its limit, naming the field", () => {
		const id = "s".repeat(RPC_INBOUND_LIMITS.identifierCharacters + 1);
		expect(refused({ type: "get_state", sessionId: id })).toContain("/sessionId");
		expect(refused({ type: "bash", command: "x".repeat(RPC_INBOUND_LIMITS.textCharacters + 1) })).toContain(
			"/command",
		);
		expect(
			refused({ type: "switch_session", sessionPath: "/".repeat(RPC_INBOUND_LIMITS.pathCharacters + 1) }),
		).toContain("/sessionPath");
		expect(
			refused({ type: "login_api_key", provider: "p", key: "k".repeat(RPC_INBOUND_LIMITS.secretCharacters + 1) }),
		).toContain("/key");
		expect(refused({ type: "get_entries", limit: -5 })).toContain("/limit");
		expect(refused({ type: "get_media", toolCallId: "t", contentIndex: 1.5 })).toContain("/contentIndex");
		expect(refused({ type: "get_entries", tail: RPC_INBOUND_LIMITS.count + 2 })).toContain("/tail");
		expect(refused({ type: "set_client_info", width: -1e308 })).toContain("/width");
		expect(
			refused({ type: "set_session_context", sessionId: "s", patch: keys(RPC_INBOUND_LIMITS.recordKeys + 1) }),
		).toContain("/patch");
		expect(
			refused({
				type: "prompt",
				message: "hi",
				images: Array.from({ length: RPC_INBOUND_LIMITS.images + 1 }, () => image),
			}),
		).toContain("/images");
		expect(
			refused({ type: "wake", delivery_ids: Array.from({ length: RPC_INBOUND_LIMITS.listItems + 1 }, () => "d") }),
		).toContain("/delivery_ids");
		expect(
			refused({ type: "account_pin", provider: "p", name: "n".repeat(RPC_INBOUND_LIMITS.identifierCharacters + 1) }),
		).toContain("/name");
	});

	it("accepts every bound class at its limit", () => {
		for (const record of [
			{ type: "get_state", sessionId: "s".repeat(RPC_INBOUND_LIMITS.identifierCharacters) },
			{ type: "bash", command: "x".repeat(RPC_INBOUND_LIMITS.textCharacters) },
			{ type: "switch_session", sessionPath: "/".repeat(RPC_INBOUND_LIMITS.pathCharacters) },
			{ type: "login_api_key", provider: "p", key: "k".repeat(RPC_INBOUND_LIMITS.secretCharacters) },
			{ type: "get_entries", limit: 0, tail: RPC_INBOUND_LIMITS.count },
			{ type: "get_media", toolCallId: "t", contentIndex: 0 },
			{ type: "set_client_info", width: 1 },
			{ type: "set_session_context", sessionId: "s", patch: keys(RPC_INBOUND_LIMITS.recordKeys) },
			{ type: "prompt", message: "hi", images: Array.from({ length: RPC_INBOUND_LIMITS.images }, () => image) },
			{ type: "wake", delivery_ids: Array.from({ length: RPC_INBOUND_LIMITS.listItems }, () => "d") },
			{ type: "account_pin", provider: "p", name: null },
			{ type: "get_state", note: "an additive field" },
			{
				type: "record_bash_result",
				command: "x",
				result: { output: "", exitCode: -9, cancelled: false, truncated: false },
			},
		])
			expect([record.type, validateRpcInboundRecord(record)]).toEqual([record.type, ACCEPTED]);
	});

	it("bounds question answers to 64 answers of at most 64 selected labels", () => {
		expect(RPC_QUESTION_ANSWER_LIMITS).toMatchObject({ answers: 64, selectedPerAnswer: 64 });
		const { answers: most, selectedPerAnswer: widest } = RPC_QUESTION_ANSWER_LIMITS;
		const response = (map: object) => ({ type: "extension_ui_response", id: "u", answers: map });
		const progress = (map: object) => ({ type: "extension_ui_progress", id: "u", answers: map });
		for (const wrap of [response, progress]) {
			expect(validateRpcInboundRecord(wrap(answers(most, widest)))).toEqual(ACCEPTED);
			expect(refused(wrap(answers(most + 1, 1)))).toContain("does not match its schema");
			expect(refused(wrap(answers(1, widest + 1)))).toContain("does not match its schema");
		}
		expect(refused(progress(answers(most + 1, 1)))).toContain("at /answers:");
		expect(refused(progress(answers(1, widest + 1)))).toContain("at /answers/q0/selected:");
	});

	it("bounds the whole record, so unknown fields and free-form payloads cannot slip past", () => {
		const huge = "x".repeat(16 * 1024 * 1024);
		expect(refused({ type: "get_state", junk: huge })).toContain("characters of JSON");
		expect(refused({ type: "prompt", message: "hi", images: [{ ...image, data: huge }] })).toContain(
			"characters of JSON",
		);
		expect(refused({ type: "host_response", id: "h", data: { blob: huge } })).toContain("characters of JSON");
	});

	it("refuses a record one character over the line limit and accepts one exactly at it", () => {
		const wrapper = JSON.stringify({ type: "get_state", pad: "" }).length;
		const atLimit = { type: "get_state", pad: "x".repeat(MAX_RPC_LINE_CHARACTERS - wrapper) };
		expect(JSON.stringify(atLimit).length).toBe(MAX_RPC_LINE_CHARACTERS);
		expect(validateRpcInboundRecord(atLimit)).toEqual(ACCEPTED);
		const overLimit = { type: "get_state", pad: "x".repeat(MAX_RPC_LINE_CHARACTERS - wrapper + 1) };
		expect(refused(overLimit)).toBe(
			`the record is ${MAX_RPC_LINE_CHARACTERS + 1} characters of JSON, at most ${MAX_RPC_LINE_CHARACTERS}.`,
		);
	});

	it("refuses non-objects, a missing or non-string type, an unknown type and an unserializable record", () => {
		for (const record of [null, [], "get_state", 7])
			expect(refused(record)).toBe("RPC command must be a JSON object.");
		expect(refused({})).toBe("type must be a string.");
		expect(refused({ type: 7 })).toBe("type must be a string.");
		expect(refused({ type: "x14_not_a_method" })).toBe('unknown record type: "x14_not_a_method".');
		expect(refused({ type: "x".repeat(100) })).toBe(`unknown record type: "${"x".repeat(64)}...".`);
		expect(refused({ type: "get_state", note: 1n })).toBe("the record is not JSON-serializable.");
	});

	it("refuses a type named after an Object.prototype key", () => {
		for (const type of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"])
			expect(refused({ type })).toBe(`unknown record type: ${JSON.stringify(type)}.`);
		const inherited: unknown = JSON.parse('{"__proto__":{"type":"get_state"}}');
		expect(refused(inherited)).toBe("type must be a string.");
	});
});

describe("open_session.env schema (senpi#4381)", () => {
	const open = (env: unknown) => ({ type: "open_session", env });

	it("accepts what the host's shape check accepts, at its limits", () => {
		for (const env of [
			{ OMOCAT_LANE: "lane-a" },
			{ _PRIVATE: "" },
			envOf(RPC_INBOUND_LIMITS.envEntries),
			{ OMOCAT_LANE: "v".repeat(RPC_INBOUND_LIMITS.envValueCharacters) },
		]) {
			expect(sessionEnvShapeError(env)).toBeUndefined();
			expect(validateRpcInboundRecord(open(env))).toEqual(ACCEPTED);
		}
	});

	it("leaves the caller-passable name set to the host that knows it", () => {
		expect(validateRpcInboundRecord(open({ SOME_OTHER_NAME: "x" }))).toEqual(ACCEPTED);
	});

	it("refuses what the host's shape check refuses, naming env", () => {
		for (const env of [
			envOf(RPC_INBOUND_LIMITS.envEntries + 1),
			{ OMOCAT_LANE: "v".repeat(RPC_INBOUND_LIMITS.envValueCharacters + 1) },
			{ omocat_lane: "x" },
			{ "1LANE": "x" },
			{ "OMOCAT-LANE": "x" },
			{ OMOCAT_LANE: 7 },
			{ OMOCAT_LANE: "a\u0000b" },
			["OMOCAT_LANE"],
			"OMOCAT_LANE=x",
			null,
		]) {
			expect(sessionEnvShapeError(env)).toBeDefined();
			expect(refused(open(env))).toContain("env");
		}
		expect(refused(open({ omocat_lane: "x" }))).toContain("does not match its schema at /env");
		expect(refused(open(envOf(RPC_INBOUND_LIMITS.envEntries + 1)))).toContain("does not match its schema at /env");
	});
});

describe("K8: every record local clients send today is accepted (X14 corpus)", () => {
	it("accepts each X14 request, including the open that precedes it", () => {
		const opened = { sessionId: NO_ID, state: { sessionFile: "/home/user/.senpi/sessions/x14.jsonl" } };
		const tmp = "/home/user/x14-scratch";
		const outcomes: Record<string, RpcInboundValidation> = {
			open_session_fresh: validateRpcInboundRecord({ type: "open_session", id: "x14-0" }),
		};
		let serial = 0;
		for (const [method, row] of Object.entries(TODAY)) {
			const { record } = corpusRequest(method, row, opened, tmp);
			outcomes[method] = validateRpcInboundRecord({ ...record, id: `x14-${++serial}` });
		}
		const answerRecords = ["extension_ui_progress", "extension_ui_response", "host_response"];
		expect([...Object.keys(TODAY), ...answerRecords].sort()).toEqual(Object.keys(RPC_METHOD_CLASS).sort());
		expect(serial).toBe(112);
		// X14 probes set_retry_fallback with an empty profile only to reach the host's "single-session only" refusal;
		// the one path that accepts the method refuses that profile with the same check (connection-handler.ts).
		const emptyProfile = corpusRequest("set_retry_fallback", TODAY.set_retry_fallback, opened, tmp).record;
		expect(emptyProfile.retryFallback).toEqual({});
		expect(sessionRetryFallbackError(emptyProfile.retryFallback)).toBeDefined();
		// X14 probes get_recovery_page and release_recovery bare only to reach the flag-off "Unknown command" answer; with
		// the flag on, the token owner refuses the same records as malformed_request, since every required field must be a
		// bounded id.
		expect(Object.entries(outcomes).filter(([, outcome]) => !outcome.ok)).toEqual([
			[
				"get_recovery_page",
				{
					ok: false,
					reason:
						"get_recovery_page: does not match its schema: must have required properties token, admissionId, componentRef, requestId.",
				},
			],
			[
				"release_recovery",
				{
					ok: false,
					reason: "release_recovery: does not match its schema: must have required properties lease, admissionId.",
				},
			],
			[
				"cancel_attempt",
				{
					ok: false,
					reason: "cancel_attempt: does not match its schema: must have required properties admissionId.",
				},
			],
			[
				"reset_stream",
				{
					ok: false,
					reason: "reset_stream: does not match its schema: must have required properties admissionId.",
				},
			],
			[
				"set_retry_fallback",
				{
					ok: false,
					reason:
						"set_retry_fallback: does not match its schema at /retryFallback: must have required properties modelFallback, fallbackChains.",
				},
			],
		]);
		expect(Object.keys(outcomes)).toHaveLength(113);
		const page = { type: "get_recovery_page", sessionId: NO_ID, token: "t", admissionId: "a", componentRef: "c" };
		expect(validateRpcInboundRecord({ ...page, requestId: "r", cursor: "k" })).toEqual(ACCEPTED);
		const wellFormed = { ...emptyProfile, retryFallback: { modelFallback: true, fallbackChains: { main: ["p/m"] } } };
		expect(sessionRetryFallbackError(wellFormed.retryFallback)).toBeUndefined();
		expect(validateRpcInboundRecord(wellFormed)).toEqual(ACCEPTED);
		expect(refused({ type: "x14_not_a_method", sessionId: NO_ID, id: "x14-stray" })).toContain("unknown record type");
	});
});
