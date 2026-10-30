/**
 * senpi#4319: the engine classifies every inbound RPC record; the table is exhaustive at compile time, the runtime
 * lookup fails closed, field-dependent entries resolve from the record under a pinned version, and the record fields
 * each rule reads are pinned so a new field cannot silently keep a lower class.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	classifyRpcMethod,
	describeRpcMethodClasses,
	RPC_METHOD_CLASS,
	RPC_METHOD_CLASSES_DIGEST,
	RPC_METHOD_CLASSES_VERSION,
	type RpcInboundRecordOf,
	type RpcMethodClass,
	type RpcMethodType,
	rpcMethodClassesDigest,
	rpcMethodPermitted,
} from "../../src/modes/rpc/method-classes.ts";
import { REVIEWED_FIELDS } from "./method-class-reviewed-fields.ts";
import { RULE_FIXTURES } from "./method-class-rule-fixtures.ts";

type Covers<K extends string> = { readonly [M in K]: unknown };
// @ts-expect-error -- exhaustiveness proof: the table has no entry for the widened literal, so it does not cover the widened union.
const widenedTable: Covers<RpcMethodType | "zz_unclassified_probe"> = RPC_METHOD_CLASS;
// @ts-expect-error -- mutation proof: the table with one entry deleted no longer covers every inbound type.
const tableWithoutPrompt: Covers<RpcMethodType> = RPC_METHOD_CLASS as Omit<typeof RPC_METHOD_CLASS, "prompt">;

type Table = typeof RPC_METHOD_CLASS;
// Every entry that can answer below device_admin: each static class under it, and every rule (a rule may answer lower).
type ReviewedType = {
	[K in RpcMethodType]: Table[K] extends "device_admin" | "connection_local" ? never : K;
}[RpcMethodType];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// The keys of every variant: plain `keyof` on a union keeps only the keys all variants share.
type AllKeys<T> = T extends unknown ? keyof T : never;
type UnreviewedType = {
	[K in ReviewedType]: Equal<
		AllKeys<RpcInboundRecordOf<K>>,
		(typeof REVIEWED_FIELDS)[K]["fields"][number]
	> extends true
		? never
		: K;
}[ReviewedType];
// A record below device_admin that gains (or loses) a field, at any variant, is named here and fails the typecheck
// until its field list is re-reviewed; a type reassigned below device_admin has no list and fails the lookup above.
const reviewedFieldsExact: [UnreviewedType] extends [never] ? true : UnreviewedType = true;

const EVERY_CLASS: ReadonlySet<RpcMethodClass> = new Set<RpcMethodClass>([
	"observe",
	"drive",
	"answer",
	"thread",
	"device_admin",
	"connection_local",
]);

const UNCLASSIFIED: ReadonlyArray<readonly [string, unknown]> = [
	["a synthetic unknown method", { type: "zz_unclassified_probe" }],
	["__proto__", JSON.parse('{"type":"__proto__"}')],
	["constructor", { type: "constructor" }],
	["toString", { type: "toString" }],
	["hasOwnProperty", { type: "hasOwnProperty" }],
	["a non-string type", { type: 7 }],
	["a missing type", {}],
	["a 10 KB type", { type: "a".repeat(10 * 1024) }],
	["a bare string record", "prompt"],
	["a number record", 7],
	["a null record", null],
	["an undefined record", undefined],
	["an array record", [{ type: "prompt" }]],
	["the transport authenticate frame", { type: "authenticate", client_proof: "p" }],
];

function digestValues(): Record<string, string> {
	const { classes, dynamic_versions } = describeRpcMethodClasses();
	const values: Record<string, string> = { ...classes };
	for (const [type, version] of Object.entries(dynamic_versions)) values[type] = `dynamic@${version}`;
	return values;
}

describe("RPC method classes (senpi#4319)", () => {
	it("holds the compile-time proofs live", () => {
		expect(widenedTable).toBe(RPC_METHOD_CLASS);
		expect(tableWithoutPrompt).toBe(RPC_METHOD_CLASS);
		expect(reviewedFieldsExact).toBe(true);
	});

	it.each(UNCLASSIFIED)("refuses %s as unclassified even with every class granted", (_name, record) => {
		expect(classifyRpcMethod(record)).toBeUndefined();
		expect(rpcMethodPermitted(record, EVERY_CLASS)).toBe(false);
	});

	it("refuses a record whose rule throws instead of crashing", () => {
		const hostile = new Proxy(
			{ type: "open_session" },
			{
				get: (target, key) => {
					if (key === "type") return target.type;
					throw new Error("hostile getter");
				},
				has: () => true,
				getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: 1 }),
			},
		);
		expect(classifyRpcMethod(hostile)).toBeUndefined();
		expect(rpcMethodPermitted(hostile, EVERY_CLASS)).toBe(false);
	});

	it("never permits connection_local, and any other class only when it is granted", () => {
		for (const [type, entry] of Object.entries(RPC_METHOD_CLASS)) {
			if (typeof entry !== "string") continue;
			const others = new Set([...EVERY_CLASS].filter((methodClass) => methodClass !== entry));
			expect([type, rpcMethodPermitted({ type }, others)]).toEqual([type, false]);
			expect([type, rpcMethodPermitted({ type }, new Set([entry]))]).toEqual([type, entry !== "connection_local"]);
		}
	});

	it("classifies the R8.b remote-session methods", () => {
		expect({
			new_session: classifyRpcMethod({ type: "new_session" }),
			list_sessions: classifyRpcMethod({ type: "list_sessions" }),
			open_session: classifyRpcMethod({ type: "open_session", sessionId: "s" }),
			get_state: classifyRpcMethod({ type: "get_state" }),
			get_effect_status: classifyRpcMethod({ type: "get_effect_status", sessionId: "s", effectId: "e" }),
			prompt: classifyRpcMethod({ type: "prompt", message: "x" }),
			abort: classifyRpcMethod({ type: "abort" }),
			fork: classifyRpcMethod({ type: "fork", entryId: "e" }),
		}).toEqual({
			new_session: "thread",
			list_sessions: "observe",
			open_session: "thread",
			get_state: "observe",
			get_effect_status: "observe",
			prompt: "drive",
			abort: "drive",
			fork: "thread",
		});
	});

	it("has no method that streams the screen (C4.b)", () => {
		const screenish = Object.keys(RPC_METHOD_CLASS).filter((type) =>
			/screen|frame|pixel|capture|display|tui|terminal|render/i.test(type),
		);
		expect(screenish).toEqual([]);
		expect(classifyRpcMethod({ type: "subscribe_sessions", mirror: "all" })).toBe("connection_local");
	});

	it("classifies open_session with a tool environment as device_admin (rule open_session@2)", () => {
		const env = { type: "open_session", sessionId: "s", env: { OMOCAT_LANE: "lane" } };
		expect(classifyRpcMethod(env)).toBe("device_admin");
		expect(rpcMethodPermitted(env, new Set<RpcMethodClass>(["thread", "drive"]))).toBe(false);
		expect(describeRpcMethodClasses().dynamic_versions.open_session).toBe(2);
	});

	it("pins every dynamic rule's outputs under <type>@<version>", () => {
		const rules = Object.entries(RPC_METHOD_CLASS).flatMap(([type, value]) =>
			typeof value === "string" ? [] : [`${type}@${value.version}`],
		);
		expect(Object.keys(RULE_FIXTURES).sort()).toEqual(rules.sort());
		for (const [key, cases] of Object.entries(RULE_FIXTURES)) {
			const type = key.slice(0, key.indexOf("@"));
			const outputs = cases.map(([name, fields]) => [name, classifyRpcMethod({ type, ...fields })]);
			expect(outputs).toEqual(cases.map(([name, , expected]) => [name, expected]));
		}
	});

	it("reviews the fields of exactly the entries that can answer below device_admin", () => {
		const below = Object.entries(RPC_METHOD_CLASS)
			.filter(([, entry]) => entry !== "device_admin" && entry !== "connection_local")
			.map(([type]) => type);
		expect(Object.keys(REVIEWED_FIELDS).sort()).toEqual(below.sort());
	});

	it("pins the reviewed field set of every dynamic rule at the rule's current version", () => {
		const versions = describeRpcMethodClasses().dynamic_versions;
		const reviewed = Object.fromEntries(
			Object.entries(REVIEWED_FIELDS).flatMap(([type, review]) =>
				"version" in review ? [[type, review.version]] : [],
			),
		);
		expect(reviewed).toEqual(versions);
	});

	it("classes a prompt that can run a slash command as device_admin (rule prompt@1)", () => {
		const command = { type: "prompt", message: "/mcp enable x" };
		expect(rpcMethodPermitted(command, new Set<RpcMethodClass>(["drive", "answer", "thread"]))).toBe(false);
		expect(rpcMethodPermitted(command, new Set<RpcMethodClass>(["device_admin"]))).toBe(true);
		expect(rpcMethodPermitted({ type: "prompt", message: "hi" }, new Set<RpcMethodClass>(["drive"]))).toBe(true);
	});

	it("digests the sorted type=class lines, dynamic entries as type=dynamic@<version>", () => {
		const values = digestValues();
		const lines = Object.entries(values)
			.map(([type, methodClass]) => `${type}=${methodClass}\n`)
			.sort()
			.join("");
		expect(lines).toContain("open_session=dynamic@2\n");
		expect(RPC_METHOD_CLASSES_DIGEST).toBe(createHash("sha256").update(lines).digest("hex"));
		expect(rpcMethodClassesDigest(Object.fromEntries(Object.entries(values).reverse()))).toBe(
			RPC_METHOD_CLASSES_DIGEST,
		);
		expect(describeRpcMethodClasses()).toMatchObject({
			version: RPC_METHOD_CLASSES_VERSION,
			digest: RPC_METHOD_CLASSES_DIGEST,
		});
	});

	it("changes the digest on one reassignment and on one rule version bump", () => {
		const values = digestValues();
		expect(rpcMethodClassesDigest({ ...values, get_state: "drive" })).not.toBe(RPC_METHOD_CLASSES_DIGEST);
		expect(rpcMethodClassesDigest({ ...values, open_session: "dynamic@3" })).not.toBe(RPC_METHOD_CLASSES_DIGEST);
		expect(rpcMethodClassesDigest({ ...values, append_session_entry: "dynamic@2" })).not.toBe(
			RPC_METHOD_CLASSES_DIGEST,
		);
	});

	it("classes host-path and device-wide settings records as device_admin", () => {
		for (const record of [
			{ type: "switch_session", sessionPath: "/x/s.jsonl" },
			{ type: "import_jsonl", inputPath: "/etc/hosts" },
			{ type: "export_html" },
			{ type: "export_jsonl", outputPath: "/tmp/out" },
			{ type: "set_steering_mode", mode: "all" },
			{ type: "set_follow_up_mode", mode: "all" },
			{ type: "set_auto_retry", enabled: true },
			{ type: "set_model", provider: "p", modelId: "m" },
			{ type: "cycle_model" },
			{ type: "cycle_thinking_level" },
			{ type: "set_fast_mode", enabled: true },
			{ type: "get_auth_providers" },
			{ type: "get_provider_accounts" },
		])
			expect([record.type, classifyRpcMethod(record)]).toEqual([record.type, "device_admin"]);
		expect(classifyRpcMethod({ type: "set_auto_compaction", enabled: true })).toBe("drive");
	});
});
