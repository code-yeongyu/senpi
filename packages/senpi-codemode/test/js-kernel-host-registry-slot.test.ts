import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";

// omo#12965: the engine keeps the values config references resolved to in a slot on its own realm's globalThis.
// Model-authored js cells run in a worker realm and must not see that slot.

const SLOT_KEY = "@code-yeongyu/senpi/config-reference-redaction/v1";

describe("JavaScript kernel realm", () => {
	it("Given the host realm holds the redaction registry slot when a cell looks for it then the cell cannot see it", async () => {
		const symbol = Symbol.for(SLOT_KEY);
		if (!Object.getOwnPropertySymbols(globalThis).includes(symbol)) {
			Object.defineProperty(globalThis, symbol, {
				value: Object.freeze({ version: 1, add() {}, size: 0, values: () => [] }),
				writable: false,
				configurable: false,
				enumerable: false,
			});
		}
		const kernel = new JavaScriptKernel({ sessionId: "registry-slot", cwd: process.cwd(), parallelPoolWidth: 1 });
		try {
			// When
			const run = await runJavaScriptCell(
				kernel,
				`const key = Symbol.for(${JSON.stringify(SLOT_KEY)}); return { visible: Object.getOwnPropertySymbols(globalThis).includes(key), value: typeof globalThis[key] };`,
			);

			// Then
			expect(parseJavaScriptResult(run.result)).toEqual({ visible: false, value: "undefined" });
		} finally {
			await kernel.close();
		}
	});
});
