import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";

function kernel(cwd: string, name: string): JavaScriptKernel {
	return new JavaScriptKernel({ sessionId: name, cwd, parallelPoolWidth: 2 });
}

describe("JavaScript runtime isolation parity", () => {
	it("Given two kernel working directories when relative reads run concurrently then each worker keeps its own cwd", async () => {
		const firstRoot = await mkdtemp(join(tmpdir(), "senpi-js-cwd-first-"));
		const secondRoot = await mkdtemp(join(tmpdir(), "senpi-js-cwd-second-"));
		const first = kernel(firstRoot, "cwd-first");
		const second = kernel(secondRoot, "cwd-second");
		try {
			await writeFile(join(firstRoot, "marker.txt"), "first");
			await writeFile(join(secondRoot, "marker.txt"), "second");

			// When
			const [firstRun, secondRun] = await Promise.all([
				runJavaScriptCell(first, 'return await read("marker.txt")'),
				runJavaScriptCell(second, 'return await read("marker.txt")'),
			]);

			// Then
			expect(parseJavaScriptResult(firstRun.result)).toBe("first");
			expect(parseJavaScriptResult(secondRun.result)).toBe("second");
		} finally {
			await Promise.all([first.close(), second.close()]);
			await Promise.all([
				rm(firstRoot, { recursive: true, force: true }),
				rm(secondRoot, { recursive: true, force: true }),
			]);
		}
	});

	it("Given two live kernels when one closes then the other keeps its globals", async () => {
		const first = kernel(process.cwd(), "dispose-first");
		const second = kernel(process.cwd(), "dispose-second");
		try {
			await runJavaScriptCell(first, "globalThis.runtimeMarker = 'first'");
			await runJavaScriptCell(second, "globalThis.runtimeMarker = 'second'");

			// When
			await first.close();
			const survivingRun = await runJavaScriptCell(second, "return globalThis.runtimeMarker");

			// Then
			expect(parseJavaScriptResult(survivingRun.result)).toBe("second");
		} finally {
			await Promise.allSettled([first.close(), second.close()]);
		}
	});
});
