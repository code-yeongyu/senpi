import { describe, expect, test, vi } from "vitest";
import { createBoundedRenderSignature } from "../src/modes/interactive/components/render-signature.ts";

function createDepthBoundaryValue(marker: string): unknown {
	let value: unknown = { marker };
	for (let index = 0; index < 6; index++) {
		value = { nested: value };
	}
	return value;
}

describe("createBoundedRenderSignature", () => {
	test("#given a very large array #when creating a render signature #then hashing does not overflow the stack", () => {
		const values = Array.from({ length: 160_000 }, (_item, index) => index);

		expect(() => createBoundedRenderSignature(values)).not.toThrow();
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
