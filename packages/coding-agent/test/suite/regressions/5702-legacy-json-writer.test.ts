import { expect, it } from "vitest";
import { legacyJsonText } from "../../../src/modes/rpc/jsonl.ts";

// senpi#5702: the explicit-stack fallback writer, split from 5702-rpc-reply-any-depth (whose host cases run under Bun).
// This file runs on Node: the error cases compare against V8's native JSON.stringify text, which the writer hardcodes;
// under Bun the native text differs (senpi#6069), so this file joins the Bun-hosted list when that lands.

const cyclic = () => {
	const message: Record<string, unknown> = { role: "user", content: "hi", timestamp: 1 };
	message.self = message;
	return [message];
};

// The fallback writer must be JSON.stringify itself wherever the native writer works: same bytes for every value
// shape the semantics name, forced through the explicit-stack path by burying the value under a deep toJSON chain.
it("the explicit-stack writer is byte-identical to JSON.stringify, toJSON/getter order included", () => {
	const order: string[] = [];
	const shapes: [string, () => unknown][] = [
		[
			"scalars",
			() => [null, true, false, 0, -0, 1.5, -1e21, Number.NaN, Number.POSITIVE_INFINITY, 'a\u2028"\\\n\ud800'],
		],
		["omitted", () => ({ a: undefined, b: () => 1, c: Symbol("s"), d: [undefined, () => 1, Symbol("s")], e: 1 })],
		["boxed", () => [Object(1), Object("s"), Object(true), new Date(0)]],
		["keys", () => ({ b: 1, 2: "two", a: { 10: 1, 1: 2, __proto__key: 3 }, ["__proto__"]: 4 })],
		["holes", () => Object.assign(new Array(3), { 0: 1, 2: 3 })],
		[
			"toJSON key",
			() => ({ k: { toJSON: (key: string) => `key:${key}` }, list: [{ toJSON: (key: string) => key }] }),
		],
		[
			"getters",
			() => ({
				get first() {
					order.push("first");
					return {
						toJSON: () => {
							order.push("first.toJSON");
							return 1;
						},
					};
				},
				get second() {
					order.push("second");
					return 2;
				},
			}),
		],
		[
			"nonplain",
			() => [new Map([[1, 2]]), new Set([1]), Object.create(null), Object.assign(Object.create({ x: 1 }), { y: 2 })],
		],
	];
	const buried = (value: unknown, depth: number) => {
		let node: unknown = value;
		for (let level = 0; level < depth; level++) {
			const inner = node;
			node = { toJSON: () => ({ inner }) };
		}
		return node;
	};
	for (const [name, make] of shapes) {
		order.length = 0;
		const expected = JSON.stringify({ inner: make() });
		const nativeOrder = [...order];
		order.length = 0;
		// 200,000 toJSON levels overflow native JSON on every engine, so this text comes from the fallback.
		const text = legacyJsonText(buried(make(), 200_000));
		expect(text.length, name).toBe(`{"inner":`.length * 199_999 + expected.length + 199_999);
		const prefix = `{"inner":`.repeat(199_999);
		expect(text.startsWith(prefix), name).toBe(true);
		expect(text.slice(prefix.length, text.length - 199_999), name).toBe(expected);
		expect(order, `${name}: getters and toJSON run once, in native order`).toEqual(nativeOrder);
	}
	for (const make of [() => ({ n: 1n }), () => ({ n: Object(1n) }), cyclic] as const) {
		let reference: unknown;
		try {
			JSON.stringify(make());
		} catch (error) {
			reference = error;
		}
		expect(() => legacyJsonText(buried(make(), 200_000))).toThrow((reference as Error).message.split("\n")[0]);
	}
}, 120_000);
