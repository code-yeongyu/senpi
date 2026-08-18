import { spawnSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { createBoundedRenderSignature } from "../src/modes/interactive/components/render-signature.ts";

describe("createBoundedRenderSignature", () => {
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

	test("#given a large array #when creating a render signature #then omitted item changes remain observable", () => {
		const values = Array.from({ length: 400 }, (_, index) => index);
		const signature = createBoundedRenderSignature(values);

		expect(signature).toContain("[+360 items hash=");

		values[200] = -1;
		expect(createBoundedRenderSignature(values)).not.toBe(signature);
	});

	test("#given a large array #when hashing under a constrained stack #then signature creation completes", () => {
		const moduleUrl = new URL("../src/modes/interactive/components/render-signature.ts", import.meta.url).href;
		const script = `
			import { createBoundedRenderSignature } from ${JSON.stringify(moduleUrl)};
			const signature = createBoundedRenderSignature(Array.from({ length: 50_000 }, (_, index) => index & 255));
			if (!signature.includes("[+49960 items hash=")) process.exit(2);
		`;
		const result = spawnSync(
			process.execPath,
			["--stack_size=256", "--import", "tsx", "--input-type=module", "--eval", script],
			{
				encoding: "utf8",
			},
		);

		expect({
			signal: result.signal,
			status: result.status,
			stderr: result.stderr,
		}).toEqual({
			signal: null,
			status: 0,
			stderr: "",
		});
	});
});
