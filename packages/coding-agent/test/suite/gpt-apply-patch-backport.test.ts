import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__testWriteFileAtomic,
	ApplyPatchError,
	type ApplyPatchPreview,
	applyPatch,
	applyPatchDetailed,
	buildPartialFailureText,
	displayPath,
	formatInFlightCallText,
	formatPatchPreview,
	truncatePreview,
} from "../../src/core/extensions/builtin/gpt-apply-patch/index.js";
import type { AtomicWriteOperations } from "../../src/core/extensions/builtin/gpt-apply-patch/types.js";
import type { Harness } from "./harness.js";
import { createHarness } from "./harness.js";

describe("gpt-apply-patch backported behavior", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("accumulates failures in applyPatchDetailed and returns recovery instructions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "ok.txt"), "before\n", "utf-8");

		const result = await applyPatchDetailed(
			harness.tempDir,
			`*** Begin Patch
*** Update File: ok.txt
@@
-before
+after
*** Update File: missing.txt
@@
-x
+y
*** End Patch`,
		);

		expect(result.summaries).toEqual(["update: ok.txt"]);
		expect(result.failures).toHaveLength(1);
		expect(result.recoveryInstructions.mustReadFiles).toEqual(["missing.txt"]);
		expect(result.recoveryInstructions.mustNotReadFiles).toEqual(["ok.txt"]);
		expect(buildPartialFailureText(result)).toContain("MUST read missing.txt");
	});

	it("keeps applyPatch fail-fast with ApplyPatchError", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "ok.txt"), "before\n", "utf-8");

		await expect(
			applyPatch(
				harness.tempDir,
				`*** Begin Patch
*** Update File: ok.txt
@@
-before
+after
*** Update File: missing.txt
@@
-x
+y
*** End Patch`,
			),
		).rejects.toBeInstanceOf(ApplyPatchError);
	});

	it("tracks fuzz tiers in detailed result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "fuzz.txt"), "value   \n", "utf-8");

		const result = await applyPatchDetailed(
			harness.tempDir,
			`*** Begin Patch
*** Update File: fuzz.txt
@@
-value
+value!
*** End Patch`,
		);

		expect(result.failures).toHaveLength(0);
		expect(result.details.fuzz).toBeGreaterThan(0);
	});

	it("writes atomically and retries on EEXIST rename", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const filePath = path.join(harness.tempDir, "atomic.txt");
		await writeFile(filePath, "old\n", "utf-8");

		let renameCalls = 0;
		const operations: AtomicWriteOperations = {
			async writeFile(tempPath, content): Promise<void> {
				await writeFile(tempPath, content, "utf-8");
			},
			async rename(fromPath, toPath): Promise<void> {
				renameCalls += 1;
				if (renameCalls === 1) {
					const error = new Error("exists") as Error & { code: string };
					error.code = "EEXIST";
					throw error;
				}
				await writeFile(toPath, await readFile(fromPath, "utf-8"), "utf-8");
			},
			async unlink(targetPath): Promise<void> {
				await writeFile(targetPath, "", "utf-8");
			},
		};

		await __testWriteFileAtomic(filePath, "new\n", operations);
		expect(await readFile(filePath, "utf-8")).toBe("new\n");
	});

	it("formats collapsed and expanded previews and in-flight text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const absoluteFile = path.join(harness.tempDir, "file.txt");
		const preview: ApplyPatchPreview = {
			files: [{ filePath: absoluteFile, operation: "update", diff: "+1 a\n-1 b", added: 1, removed: 1 }],
			added: 1,
			removed: 1,
		};

		expect(displayPath(absoluteFile, harness.tempDir)).toBe("file.txt");
		expect(formatPatchPreview(preview, harness.tempDir, false)).not.toContain("+1 a");
		expect(formatPatchPreview(preview, harness.tempDir, true)).toContain("+1 a");
		expect(formatInFlightCallText("*** Begin Patch\n*** Update File: a.ts\n*** End Patch")).toContain("Patching");
	});

	it("truncates long previews with ellipsis", async () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
		const truncated = truncatePreview(lines);
		expect(truncated).toContain("…");
		expect(truncated.split("\n").length).toBeLessThan(30);
	});

	it("applies add file patch using atomic write path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await mkdir(path.join(harness.tempDir, "nested"), { recursive: true });
		const summaries = await applyPatch(
			harness.tempDir,
			`*** Begin Patch
*** Add File: nested/new.txt
+hello
*** End Patch`,
		);
		expect(summaries).toEqual(["add: nested/new.txt"]);
		expect(await readFile(path.join(harness.tempDir, "nested/new.txt"), "utf-8")).toBe("hello\n");
	});
});
