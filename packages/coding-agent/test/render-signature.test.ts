import { describe, expect, test, vi } from "vitest";
import { createBoundedRenderSignature } from "../src/modes/interactive/components/render-signature.ts";

describe("createBoundedRenderSignature", () => {
	test("copies wide collection entries only a linear number of times", () => {
		const values = Array.from({ length: 1_600 }, (_, index) => index);
		const originalSlice = Array.prototype.slice;
		let copiedEntries = 0;
		const sliceSpy = vi.spyOn(Array.prototype, "slice").mockImplementation(function (
			this: unknown[],
			start?: number,
			end?: number,
		) {
			const result = originalSlice.call(this, start, end);
			copiedEntries += result.length;
			return result;
		});

		try {
			createBoundedRenderSignature(values);
			createBoundedRenderSignature(Object.fromEntries(values.map((value) => [`key-${value}`, value])));
		} finally {
			sliceSpy.mockRestore();
		}

		expect(copiedEntries).toBeLessThanOrEqual(values.length * 4);
	});

	test("detects mutations to the final array value and object key or value", () => {
		const values = Array.from({ length: 81 }, (_, index) => ({ value: index }));
		const arrayBefore = createBoundedRenderSignature(values);
		values[80].value = -1;
		expect(createBoundedRenderSignature(values)).not.toBe(arrayBefore);

		const object = Object.fromEntries(Array.from({ length: 161 }, (_, index) => [`key-${index}`, index]));
		const objectBefore = createBoundedRenderSignature(object);
		object["key-99"] = -1;
		expect(createBoundedRenderSignature(object)).not.toBe(objectBefore);
		const changedValue = createBoundedRenderSignature(object);
		delete object["key-99"];
		object["key-zz"] = -1;
		expect(createBoundedRenderSignature(object)).not.toBe(changedValue);
	});

	test("passes original array indices and object keys to tail JSON serializers", () => {
		const keys: string[] = [];
		const value = { toJSON: (key: string) => keys.push(key) };
		const array = Array.from<unknown>({ length: 81 }).fill(null);
		array[80] = value;
		const object: Record<string, unknown> = Object.fromEntries(
			Array.from({ length: 81 }, (_, index) => [`key-${String(index).padStart(3, "0")}`, null]),
		);
		object["key-080"] = value;

		createBoundedRenderSignature(array);
		createBoundedRenderSignature(object);
		expect(keys).toEqual(["80", "key-080"]);
	});

	test("retains cycle detection for references in collection tails", () => {
		const array: unknown[] = Array.from({ length: 41 }, (_, index) => index);
		array.push(array);
		const object: Record<string, unknown> = Object.fromEntries(
			Array.from({ length: 81 }, (_, index) => [`key-${index}`, index]),
		);
		object.tail = object;

		expect(() => createBoundedRenderSignature(array)).not.toThrow();
		expect(() => createBoundedRenderSignature(object)).not.toThrow();
	});

	test("distinguishes sparse tail holes from explicit undefined", () => {
		const values = Array.from<unknown>({ length: 41 }).fill(null);
		delete values[40];
		const sparse = createBoundedRenderSignature(values);
		values[40] = undefined;
		expect(createBoundedRenderSignature(values)).not.toBe(sparse);
	});

	test("snapshots the tail before JSON serializers append or replace entries", () => {
		const values: unknown[] = Array.from({ length: 40 }).fill(null);
		const nextSerializer = vi.fn(() => "original");
		let calls = 0;
		const appendingValue = {
			toJSON: () => {
				if (++calls > 1) throw new Error("Appended values must wait for the next signature");
				values.push(appendingValue);
				values[41] = "replacement";
				return "serialized";
			},
		};
		values.push(appendingValue, { toJSON: nextSerializer });

		expect(() => createBoundedRenderSignature(values)).not.toThrow();
		expect(calls).toBe(1);
		expect(nextSerializer).toHaveBeenCalledOnce();
	});

	test("retains the depth limit while visiting collection tails", () => {
		const serializer = vi.fn(() => "too deep");
		let nested: unknown = { toJSON: serializer };
		for (let depth = 0; depth < 8; depth++) {
			const values: unknown[] = Array.from({ length: 40 }).fill(null);
			values.push(nested);
			nested = values;
		}

		createBoundedRenderSignature(nested);
		expect(serializer).not.toHaveBeenCalled();
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
