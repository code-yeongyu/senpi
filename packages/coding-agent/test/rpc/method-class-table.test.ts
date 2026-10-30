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
import type { RpcResponse } from "../../src/modes/rpc/rpc-response-types.ts";
import { RULE_FIELDS, RULE_FIXTURES } from "./method-class-rule-fixtures.ts";

type Covers<K extends string> = { readonly [M in K]: unknown };
// @ts-expect-error -- exhaustiveness proof: the table has no entry for the widened literal, so it does not cover the widened union.
const widenedTable: Covers<RpcMethodType | "zz_unclassified_probe"> = RPC_METHOD_CLASS;
// @ts-expect-error -- mutation proof: the table with one entry deleted no longer covers every inbound type.
const tableWithoutPrompt: Covers<RpcMethodType> = RPC_METHOD_CLASS as Omit<typeof RPC_METHOD_CLASS, "prompt">;

type Table = typeof RPC_METHOD_CLASS;
type DynamicType = { [K in RpcMethodType]: Table[K] extends string ? never : K }[RpcMethodType];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type RuleFieldsExact = {
	readonly [K in DynamicType]: Equal<keyof RpcInboundRecordOf<K>, (typeof RULE_FIELDS)[K]["fields"][number]>;
};
// A record type that gains (or loses) a field makes its row `false` here, so the rule is re-reviewed before it compiles.
const ruleFieldsExact: RuleFieldsExact = {
	open_session: true,
	new_session: true,
	get_effect_status: true,
	set_thinking_level: true,
	append_session_entry: true,
};

type KeyMaterialName =
	| `${string}apikey${string}`
	| `${string}api_key${string}`
	| `${string}secret${string}`
	| `${string}password${string}`
	| `${string}privatekey${string}`
	| `${string}private_key${string}`
	| `${string}accesstoken${string}`
	| `${string}access_token${string}`
	| `${string}refreshtoken${string}`
	| `${string}refresh_token${string}`
	| `${string}credential${string}`
	| `${string}bearer${string}`
	| `${string}oauth${string}`
	| "authorization"
	| "cookie";
type NextDepth = [never, 0, 1, 2, 3, 4, 5, 6, 7];
// An index-signature key is `string`, which would absorb every literal name in the union and hide a leak: skip its
// name, keep walking its value.
type LiteralName<K extends string> = string extends K ? never : Lowercase<K>;
// Key material is a free-form string, bytes, or a structure holding them; a boolean flag or a literal enum cannot be.
type CanCarryMaterial<V> = [Extract<V, object>] extends [never]
	? string extends Extract<V, string>
		? true
		: false
	: true;
type MaterialName<T, K extends keyof T & string> = CanCarryMaterial<T[K]> extends true ? LiteralName<K> : never;
type DeepKeys<T, D extends number = 8> = [D] extends [never]
	? never
	: T extends readonly (infer E)[]
		? DeepKeys<E, NextDepth[D]>
		: T extends (...args: never[]) => unknown
			? never
			: T extends object
				? { [K in keyof T & string]-?: MaterialName<T, K> | DeepKeys<T[K], NextDepth[D]> }[keyof T & string]
				: never;
type ObserveType =
	| { [K in RpcMethodType]: Table[K] extends "observe" ? K : never }[RpcMethodType]
	| "get_effect_status";
type ObserveReplyData =
	Extract<RpcResponse, { command: ObserveType; success: true }> extends infer R
		? R extends { data: infer D }
			? D
			: never
		: never;
type LeakedKeyNames = Extract<DeepKeys<ObserveReplyData>, KeyMaterialName>;
// No observe-class reply carries a field named like key material, at any depth the forwarder could relay.
const observeRepliesCarryNoKeyMaterial: [LeakedKeyNames] extends [never] ? true : LeakedKeyNames = true;
// The guard can fail: a nested credential field is found next to an index signature.
const guardSeesNestedKey: Extract<
	DeepKeys<{ labels: Record<string, string>; a: { b: [{ refreshToken: string }] } }>,
	KeyMaterialName
> = "refreshtoken";
// ...and a flag that only names a credential is not material (AssistantMessage.credentialServedRecently, senpi#2491).
const guardSkipsFlags: [
	Extract<DeepKeys<{ credentialServedRecently?: true; authStatus: "ok" | "none" }>, KeyMaterialName>,
] extends [never]
	? true
	: false = true;

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
		expect(Object.values(ruleFieldsExact).every(Boolean)).toBe(true);
		expect(observeRepliesCarryNoKeyMaterial).toBe(true);
		expect(guardSeesNestedKey).toBe("refreshtoken");
		expect(guardSkipsFlags).toBe(true);
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

	it("pins the reviewed field set of every dynamic rule at the rule's current version", () => {
		const versions = describeRpcMethodClasses().dynamic_versions;
		const reviewed = Object.fromEntries(Object.entries(RULE_FIELDS).map(([type, { version }]) => [type, version]));
		expect(reviewed).toEqual(versions);
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
