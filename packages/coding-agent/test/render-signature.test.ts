import { describe, expect, test, vi } from "vitest";
import { createBoundedRenderSignature } from "../src/modes/interactive/components/render-signature.ts";

function createDepthBoundaryValue(marker: string): unknown {
	let value: unknown = { marker };
	for (let index = 0; index < 6; index++) {
		value = { nested: value };
	}
	return value;
}

function stackDepth(): number {
	return new Error().stack?.split("\n").length ?? 0;
}

const OMITTED_TAIL_SHAPES = [
	{
		name: "array",
		build: (count: number, probe: (index: number) => unknown): unknown =>
			Array.from({ length: 40 + count }, (_item, index) => (index < 40 ? index : probe(index - 40))),
	},
	{
		name: "object",
		build: (count: number, probe: (index: number) => unknown): unknown =>
			Object.fromEntries(
				Array.from({ length: 80 + count }, (_item, index) => [
					`key-${index.toString().padStart(6, "0")}`,
					index < 80 ? index : probe(index - 80),
				]),
			),
	},
] as const;

describe("createBoundedRenderSignature", () => {
	// #4415: each recursion level kept a copy of the remaining tail alive, so live memory grew quadratically
	// and Node aborted at its heap limit on wide tool results.
	test.each(OMITTED_TAIL_SHAPES)(
		"#given a wide $name #when its omitted tail is hashed #then call depth does not grow with the omitted count",
		({ build }) => {
			const omittedCount = 4_000;
			const depths = new Map<number, number>();
			const probe = (index: number): unknown => ({
				toJSON: () => {
					depths.set(index, stackDepth());
					return index;
				},
			});
			const previousLimit = Error.stackTraceLimit;
			Error.stackTraceLimit = Number.POSITIVE_INFINITY;
			try {
				createBoundedRenderSignature(build(omittedCount, probe));
			} finally {
				Error.stackTraceLimit = previousLimit;
			}

			expect(depths.size).toBe(omittedCount);
			expect(depths.get(omittedCount - 1)).toBe(depths.get(0));
		},
	);

	test("#given a wide array #when its final item changes #then the omitted tail change is detected", () => {
		const values = Array.from({ length: 4_000 }, (_item, index) => index);

		const before = createBoundedRenderSignature(values);
		values[values.length - 1] = -1;
		const after = createBoundedRenderSignature(values);

		expect(after).not.toBe(before);
	});

	test("#given arrays differing after the item limit #when creating signatures #then the tail change is detected", () => {
		const unchangedPrefix = Array.from({ length: 40 }, (_item, index) => `prefix-${index}`);
		const previous = [...unchangedPrefix, "tail-old"];
		const next = [...unchangedPrefix, "tail-new"];

		expect(createBoundedRenderSignature(next)).not.toBe(createBoundedRenderSignature(previous));
	});

	test("#given an omitted array hole and undefined #when creating signatures #then they remain distinct", () => {
		const withHole = Array.from({ length: 41 }, () => 0);
		delete withHole[40];
		const withUndefined: (number | undefined)[] = Array.from({ length: 41 }, () => 0);
		withUndefined[40] = undefined;

		expect(createBoundedRenderSignature(withHole)).not.toBe(createBoundedRenderSignature(withUndefined));
	});

	test("#given an omitted getter extends its array #when creating a signature #then hashing uses the original tail", () => {
		const values: unknown[] = Array.from({ length: 41 }, () => 0);
		Object.defineProperty(values, 40, {
			get() {
				values.push("late");
				return "tail";
			},
		});
		const expected: unknown[] = Array.from({ length: 41 }, () => 0);
		expected[40] = "tail";

		expect(createBoundedRenderSignature(values)).toBe(createBoundedRenderSignature(expected));
	});

	test("#given a key-sensitive omitted serializer #when its value changes #then the synthetic key remains stable", () => {
		let marker = "before";
		const serializerKeys: string[] = [];
		const values: unknown[] = Array.from({ length: 81 }, () => 0);
		values[80] = {
			toJSON(key: string) {
				serializerKeys.push(key);
				return key === "0" ? marker : "constant";
			},
		};

		const before = createBoundedRenderSignature(values);
		marker = "after";
		const after = createBoundedRenderSignature(values);

		expect(serializerKeys).toEqual(["0", "0"]);
		expect(after).not.toBe(before);
	});

	test("#given an omitted circular reference #when creating a signature #then ancestor tracking remains bounded", () => {
		const values: unknown[] = Array.from({ length: 41 }, () => 0);
		values[40] = values;

		expect(() => createBoundedRenderSignature(values)).not.toThrow();
	});

	test("#given objects differing after the key limit #when creating signatures #then the omitted change is detected", () => {
		const entries = Array.from(
			{ length: 81 },
			(_item, index) => [`key-${index.toString().padStart(3, "0")}`, index] as const,
		);
		const previous = Object.fromEntries(entries);
		const next = { ...previous, "key-080": "changed" };

		expect(createBoundedRenderSignature(next)).not.toBe(createBoundedRenderSignature(previous));
	});

	test("#given a wide object #when its final value changes #then the omitted entry change is detected", () => {
		const values = Object.fromEntries(
			Array.from({ length: 4_000 }, (_item, index) => [`key-${index.toString().padStart(6, "0")}`, index]),
		);

		const before = createBoundedRenderSignature(values);
		values["key-003999"] = -1;
		const after = createBoundedRenderSignature(values);

		expect(after).not.toBe(before);
	});

	test("#given deeply nested omitted array values #when creating signatures #then the prior depth budget is preserved", () => {
		const unchangedPrefix = Array.from({ length: 40 }, (_item, index) => `prefix-${index}`);
		const previous = { content: [...unchangedPrefix, createDepthBoundaryValue("depth-old")] };
		const next = { content: [...unchangedPrefix, createDepthBoundaryValue("depth-new")] };

		expect(createBoundedRenderSignature(next)).not.toBe(createBoundedRenderSignature(previous));
	});

	test("#given deeply nested omitted object values #when creating signatures #then the prior depth budget is preserved", () => {
		const unchangedPrefix = Object.fromEntries(
			Array.from({ length: 80 }, (_item, index) => [`key-${index.toString().padStart(3, "0")}`, index]),
		);
		const previous = { details: { ...unchangedPrefix, "zz-tail": createDepthBoundaryValue("depth-old") } };
		const next = { details: { ...unchangedPrefix, "zz-tail": createDepthBoundaryValue("depth-new") } };

		expect(createBoundedRenderSignature(next)).not.toBe(createBoundedRenderSignature(previous));
	});

	test("#given large strings #when creating a render signature #then string hashing work is bounded", () => {
		const largeText = `large-signature:${"a".repeat(64 * 1024)}`;
		const charCodeSpy = vi.spyOn(String.prototype, "charCodeAt");

		try {
			const signature = createBoundedRenderSignature({
				content: largeText,
				nested: [{ details: `large-details:${"b".repeat(64 * 1024)}` }],
			});

			expect(signature).toContain("string length=");
			expect(charCodeSpy.mock.calls.length).toBeLessThan(2_000);
		} finally {
			charCodeSpy.mockRestore();
		}
	});
});
