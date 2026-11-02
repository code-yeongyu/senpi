import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

describe.each([true, false])("literal evaluation compatibility (active=%s)", (active) => {
	it("retains direct eval lexical scope", async () => {
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			permissions: {
				state: () => ({ epoch: 1, active, rules: [{ permission: "read", pattern: "unused", layer: "user" }] }),
				decide: () => ({ action: "pass" }),
			},
		});
		try {
			const result = await kernel.run({
				cellId: "direct-eval",
				code: "return (()=>{const localValue=7;return eval('localValue')})()",
				timeoutMs: 8000,
			});
			expect(result).toMatchObject({ ok: true, valueRepr: "7" });
		} finally {
			await kernel.close();
		}
	});
});
