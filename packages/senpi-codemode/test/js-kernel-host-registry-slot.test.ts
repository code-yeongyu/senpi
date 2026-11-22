import "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";

// omo#12965: the engine keeps the values config references resolved to in a slot on its own realm's globalThis.
// Model-authored js cells run in a worker realm and must not see that slot.

const SLOT_KEY = "@code-yeongyu/senpi/config-reference-redaction/v1";

// omo#12965: every table one engine copy writes and another reads is a registry pinned the same way, under
// `Symbol.for("@code-yeongyu/senpi/<name>/v1")`: approval decisions, the delegated-origin scope, provider strict mode,
// kill-guard runtimes, session writers, the file-mutation queue, the kernel-tool contexts and codemode's cross-session
// cell authority. A cell must see none of them.
const REGISTRY_PREFIX = "@code-yeongyu/senpi/";
const KNOWN_KEYS = [
	SLOT_KEY,
	"@code-yeongyu/senpi/decision-sessions/v1",
	"@code-yeongyu/senpi/turn-origin/v1",
	"@code-yeongyu/senpi/provider-scope/v1",
	"@code-yeongyu/senpi/kill-guard/v1",
	"@code-yeongyu/senpi/session-writers/v1",
	"@code-yeongyu/senpi/file-mutation-queue/v1",
	"@code-yeongyu/senpi/kernel-tools/v1",
	"@code-yeongyu/senpi/codemode-cell-authority/v1",
];

/** Every registry key the loaded engine pinned in this realm, so a registry added later is covered without an edit. */
function hostRegistryKeys(): string[] {
	return Object.getOwnPropertySymbols(globalThis)
		.map((symbol) => Symbol.keyFor(symbol))
		.filter((key): key is string => key !== undefined && key.startsWith(REGISTRY_PREFIX))
		.sort();
}

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

	it("Given the host realm holds every engine registry when a cell looks for them then the cell sees none", async () => {
		const keys = hostRegistryKeys();
		expect(keys).toEqual(expect.arrayContaining(KNOWN_KEYS));
		const kernel = new JavaScriptKernel({ sessionId: "registry-keys", cwd: process.cwd(), parallelPoolWidth: 1 });
		try {
			// When
			const run = await runJavaScriptCell(
				kernel,
				`const own = Object.getOwnPropertySymbols(globalThis);
return ${JSON.stringify(keys)}.filter((name) => {
	const key = Symbol.for(name);
	return own.includes(key) || globalThis[key] !== undefined;
});`,
			);

			// Then
			expect(parseJavaScriptResult(run.result)).toEqual([]);
		} finally {
			await kernel.close();
		}
	});
});
