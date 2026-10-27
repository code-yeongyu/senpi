import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { normalizeJsonValue } from "../../src/modes/rpc/json-normal-value.ts";
import { omitInlineMedia } from "../../src/modes/rpc/media-placeholders.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const image = () => ({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
const record = (details: unknown, block: object = image()) => ({
	type: "tool_execution_end",
	toolCallId: "call",
	result: { content: [block], details },
});

// Part of #4272: projection must see exactly the value the old binding's JSON round trip produced.
it("projects the JSON representation of a toJSON image without live parsing", () => {
	const input = record(null, {
		...image(),
		toJSON(key: string) {
			expect(key).toBe("0");
			return { ...image(), data: "d29ybGQgd29ybGQ=" };
		},
	});
	const expected = JSON.stringify(omitInlineMedia(JSON.parse(JSON.stringify(input))));
	const parse = vi.spyOn(JSON, "parse");
	try {
		expect(JSON.stringify(omitInlineMedia(input))).toBe(expected);
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
	}
});

type Observations = { getters: number; keys: string[] };

function generated(seed: number, observations: Observations): unknown {
	let state = seed >>> 0;
	const random = (bound: number) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % bound;
	};
	const value = (depth: number): unknown => {
		const kind = random(depth === 0 ? 16 : 21);
		switch (kind) {
			case 0:
				return undefined;
			case 1:
				return () => 1;
			case 2:
				return Symbol("ignored");
			case 3:
				return [NaN, Infinity, -Infinity, -0][random(4)];
			case 4:
				return null;
			case 5:
				return random(1000);
			case 6:
				return `value-${random(1000)}`;
			case 7:
				return Boolean(random(2));
			case 8:
				return new Date(random(2) ? 1_700_000_000_000 : NaN);
			case 9:
				return new Map([["ignored", 1]]);
			case 10:
				return new Set([1, 2]);
			case 11:
				return Object(random(100));
			case 12:
				return Object(`boxed-${random(100)}`);
			case 13:
				return Object(Boolean(random(2)));
			case 14:
				return { [Symbol("hidden")]: 1, own: "visible" };
			case 15:
				return Object.defineProperty({ own: 1 }, "hidden", { value: "not enumerable" });
			case 16: {
				const array = new Array<unknown>(4);
				for (let index = 0; index < array.length; index++) if (random(2)) array[index] = value(depth - 1);
				return array;
			}
			case 17:
				return { first: value(depth - 1), second: value(depth - 1), absent: undefined, fn() {} };
			case 18: {
				const child = value(depth - 1);
				return {
					toJSON(key: string) {
						observations.keys.push(key);
						return { nested: child, omitted: undefined };
					},
				};
			}
			case 19: {
				const child = value(depth - 1);
				return {
					get property() {
						observations.getters++;
						return child;
					},
				};
			}
			default: {
				const primitive = random(100);
				return {
					toJSON(key: string) {
						observations.keys.push(key);
						return primitive;
					},
				};
			}
		}
	};
	return value(3);
}

it("matches reference bytes and observable calls over 512 seeded bounded values", () => {
	for (let seed = 1; seed <= 512; seed++) {
		const reference: Observations = { getters: 0, keys: [] };
		const actual: Observations = { getters: 0, keys: [] };
		const frozen = JSON.parse(JSON.stringify(record(generated(seed, reference))));
		const expected = JSON.stringify(omitInlineMedia(frozen));
		expect(JSON.stringify(omitInlineMedia(record(generated(seed, actual)))), `seed=${seed}`).toBe(expected);
		expect(actual, `observable calls for seed=${seed}`).toEqual(reference);
		const normalized: Observations = { getters: 0, keys: [] };
		expect(
			JSON.stringify(normalizeJsonValue(record(generated(seed, normalized))).value),
			`normalizing walk for seed=${seed}`,
		).toBe(JSON.stringify(frozen));
		expect(normalized, `normalizing calls for seed=${seed}`).toEqual(reference);
	}
});

it("matches nested toJSON keys, primitive returns, Dates, omissions and sparse arrays", () => {
	const make = (observed: Observations) =>
		record({
			toJSON(key: string) {
				observed.keys.push(key);
				return {
					nested: {
						toJSON(nestedKey: string) {
							observed.keys.push(nestedKey);
							return "primitive";
						},
					},
					date: new Date("2026-10-25T00:00:00Z"),
					array: [undefined, () => 1, Symbol("x"), ...new Array<unknown>(1), NaN, Infinity, -0],
					absent: undefined,
					fn() {},
					symbol: Symbol("x"),
				};
			},
		});
	const expectedCalls: Observations = { getters: 0, keys: [] };
	const calls: Observations = { getters: 0, keys: [] };
	const expected = JSON.stringify(omitInlineMedia(JSON.parse(JSON.stringify(make(expectedCalls)))));
	expect(JSON.stringify(omitInlineMedia(make(calls)))).toBe(expected);
	expect(calls.keys).toEqual(["details", "nested"]);
	expect(calls).toEqual(expectedCalls);
});

it("snapshots getters once before later getters can mutate earlier properties", async () => {
	const make = (observed: Observations) => {
		const earlier = { value: "original" };
		return record({
			earlier,
			get later() {
				observed.getters++;
				earlier.value = "mutated";
				return "last";
			},
		});
	};
	const reference: Observations = { getters: 0, keys: [] };
	const expected = `${JSON.stringify({
		...omitInlineMedia(JSON.parse(JSON.stringify(make(reference)))),
		sessionId: "session",
	})}\n`;
	const actual: Observations = { getters: 0, keys: [] };
	const lines: string[] = [];
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection("peer", {
		writeRaw: (line) => lines.push(line),
		waitForBackpressure: async () => {},
	});
	writer.setConnectionCapabilities("peer", ["media_placeholders"]);
	writer.attachConnectionToSession("peer", "session");
	const parse = vi.spyOn(JSON, "parse");
	try {
		writer.enqueue("session", make(actual));
		await writer.flush();
		expect(lines).toEqual([expected]);
		expect(actual.getters).toBe(1);
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
		writer.unregisterConnection("peer");
	}
});

// Part of #4272: deep nesting must succeed or fail exactly where native JSON.stringify does. A fresh
// process keeps the walk cold: warmed-up code uses smaller frames and hides the earlier overflow.
it("normalizes deeply nested arrays like the JSON round trip", async () => {
	const source = new URL("../../src/modes/rpc/json-normal-value.ts", import.meta.url).href;
	const script = `
		const { normalizeJsonValue } = await import(${JSON.stringify(source)});
		const deep = (depth) => { let nested = []; for (let level = 0; level < depth; level++) nested = [nested]; return nested; };
		let low = 1;
		let high = 200000;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			try { JSON.stringify(deep(middle)); low = middle; } catch { high = middle - 1; }
		}
		const outcome = (run) => { try { return JSON.stringify(run()); } catch (error) { return error.name; } };
		const results = [low - 16, 20000].map((depth) => {
			const input = { type: "tool_execution_end", result: { content: [], details: deep(depth) } };
			const reference = outcome(() => JSON.parse(JSON.stringify(input)));
			const normalized = outcome(() => normalizeJsonValue(input).value);
			return { depth, same: normalized === reference, reference: reference.slice(0, 48), normalized: normalized.slice(0, 48) };
		});
		process.stdout.write(JSON.stringify(results));`;
	const args = process.versions.bun ? ["-e", script] : ["--input-type=module", "-e", script];
	const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 60_000 });
	const results: { depth: number; same: boolean; reference: string; normalized: string }[] = JSON.parse(stdout);
	expect(results).toHaveLength(2);
	for (const { depth, same, reference, normalized } of results)
		expect({ depth, same, normalized }).toEqual({ depth, same: true, normalized: reference });
}, 90_000);

it.each(["BigInt", "cycle"])("throws the reference error class for %s", (kind) => {
	const make = () => {
		const value: Record<string, unknown> = {};
		if (kind === "BigInt") value.value = 1n;
		else value.self = value;
		return record(value);
	};
	let reference: unknown;
	try {
		JSON.parse(JSON.stringify(make()));
	} catch (error) {
		reference = error;
	}
	expect(reference).toBeInstanceOf(TypeError);
	expect(() => normalizeJsonValue(make())).toThrowError(TypeError);
	expect(() => omitInlineMedia(make())).toThrowError(TypeError);
});
