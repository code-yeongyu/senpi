import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

type ResultFrame = Extract<KernelToHostMessage, { type: "result" }>;

const PRELUDE_FRAME = /at\s+(?:globalThis\.)?__senpi_import__\s+\(?([^\s()]+):\d+:\d+\)?/u;

// __senpi_import__ throws inside the eval'd loader prelude, so its stack frame
// carries the source URL the prelude was evaluated under for that cell.
const STACK_PROBE = [
	"try {",
	'\tawait __senpi_import__("no-such-root-scheme://x");',
	'\treturn "unexpected-success";',
	"} catch (error) {",
	"\treturn error instanceof Error ? error.stack : String(error);",
	"}",
].join("\n");

async function runProbe(kernel: JavaScriptKernel, cellId: string): Promise<string> {
	const result: ResultFrame = await kernel.run({ cellId, code: STACK_PROBE, timeoutMs: 10_000 });
	if (!result.ok || result.valueRepr === undefined) {
		throw new Error(`probe cell failed: ${JSON.stringify(result)}`);
	}
	return result.valueRepr;
}

function preludeFrameUrl(stack: string): string {
	const match = PRELUDE_FRAME.exec(stack);
	if (match === null) throw new Error(`no __senpi_import__ frame in:\n${stack}`);
	return match[1];
}

describe("JS kernel loader prelude source URL (#2263)", () => {
	it("evaluates the prelude under one stable URL across cells of a worker generation", async () => {
		const kernel = new JavaScriptKernel({
			sessionId: "prelude-source-url",
			cwd: process.cwd(),
			parallelPoolWidth: 1,
		});
		try {
			const first = preludeFrameUrl(await runProbe(kernel, "url-first"));
			const second = preludeFrameUrl(await runProbe(kernel, "url-second"));
			expect(first).toBe(second);
			expect(first).not.toContain("url-first");
			expect(second).not.toContain("url-second");
		} finally {
			await kernel.close();
		}
	});
});
