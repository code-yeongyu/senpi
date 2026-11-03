/**
 * senpi#4319 key-material guard: no observe-class reply type carries a field NAMED like key material, at any depth a
 * forwarder could relay. A name-based walk over the reply types; index-signature records, `unknown` subtrees and
 * free-form text are outside what it can see.
 */
import { describe, expect, it } from "vitest";
import type { RPC_METHOD_CLASS, RpcMethodType } from "../../src/modes/rpc/method-classes.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-response-types.ts";

type Table = typeof RPC_METHOD_CLASS;
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

describe("RPC method classes key-material guard (senpi#4319)", () => {
	it("holds the compile-time proofs live", () => {
		expect(observeRepliesCarryNoKeyMaterial).toBe(true);
		expect(guardSeesNestedKey).toBe("refreshtoken");
		expect(guardSkipsFlags).toBe(true);
	});
});
