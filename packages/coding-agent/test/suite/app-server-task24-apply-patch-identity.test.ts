import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import { EventProjector } from "../../src/modes/app-server/threads/projection.ts";
import { fileChangeProjection } from "../../src/modes/app-server/threads/projection-file-changes.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

async function createApplyPatchHarness(): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	return harness;
}

async function executeApplyPatch(harness: Harness, input: string) {
	const tool = createApplyPatchTool();
	return tool.execute("apply-call", { input }, undefined, undefined, harness.session.extensionRunner.createContext());
}

function valueAt(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`expected object containing ${key}`);
	}
	return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function projectCompletion(input: string, result: unknown): { readonly item: unknown; readonly diff: string } {
	const projector = new EventProjector({ threadId: "thread", turnId: "turn" });
	projector.project({
		type: "tool_execution_start",
		toolCallId: "apply-call",
		toolName: "apply_patch",
		args: { input },
	});
	const notifications = projector.project({
		type: "tool_execution_end",
		toolCallId: "apply-call",
		toolName: "apply_patch",
		result,
		isError: false,
	}).notifications;
	const completed = notifications.find((notification) => notification.method === "item/completed");
	const diffUpdated = notifications.find((notification) => notification.method === "turn/diff/updated");
	if (!completed || !diffUpdated)
		throw new TypeError("expected completed fileChange and cumulative diff notifications");
	const diff = valueAt(diffUpdated.params, "diff");
	if (typeof diff !== "string") throw new TypeError("expected cumulative diff text");
	return { item: valueAt(completed.params, "item"), diff };
}

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("app-server task 24 apply_patch operation identity", () => {
	it("projects only the successful operation when a later same-path operation fails", async () => {
		// Given: two real patch operations target the same file, but only the first can match.
		const harness = await createApplyPatchHarness();
		await writeFile(join(harness.tempDir, "same.txt"), "a\nb\n", "utf8");
		const input = `*** Begin Patch
*** Update File: same.txt
@@
-a
+A
*** Update File: same.txt
@@
-a
+AA
*** End Patch`;

		// When: the real tool executes and its exact result flows through both projection seams.
		const result = await executeApplyPatch(harness, input);
		const projection = fileChangeProjection({
			id: "apply-call",
			name: "apply_patch",
			args: { input },
			status: "completed",
			result,
		});
		const completed = projectCompletion(input, result);

		// Then: the real file, completed item, and cumulative turn diff all report only the first mutation.
		expect(await readFile(join(harness.tempDir, "same.txt"), "utf8")).toBe("A\nb\n");
		expect(result.details?.result?.failures).toHaveLength(1);
		expect(parsePatch(projection.diff)).toHaveLength(1);
		expect(projection.item).toMatchObject({
			changes: [{ path: "same.txt", kind: { type: "update", move_path: null } }],
		});
		expect(projection.diff).toContain("-a\n+A");
		expect(projection.diff).not.toContain("+AA");
		expect(completed).toEqual({ item: projection.item, diff: projection.diff });
	});

	it("projects dependent same-path successes in operation source order", async () => {
		// Given: the second real patch operation can match only after the first succeeds.
		const harness = await createApplyPatchHarness();
		await writeFile(join(harness.tempDir, "same.txt"), "a\nb\n", "utf8");
		const input = `*** Begin Patch
*** Update File: same.txt
@@
-a
+A
*** Update File: same.txt
@@
-A
+AA
*** End Patch`;

		// When: the real tool executes and its exact result flows through both projection seams.
		const result = await executeApplyPatch(harness, input);
		const projection = fileChangeProjection({
			id: "apply-call",
			name: "apply_patch",
			args: { input },
			status: "completed",
			result,
		});
		const completed = projectCompletion(input, result);

		// Then: both successful mutations appear in source order and agree with the final file.
		expect(await readFile(join(harness.tempDir, "same.txt"), "utf8")).toBe("AA\nb\n");
		expect(result.details?.result?.failures).toEqual([]);
		expect(parsePatch(projection.diff)).toHaveLength(2);
		expect(projection.item).toMatchObject({
			changes: [
				{ path: "same.txt", kind: { type: "update", move_path: null }, diff: expect.stringContaining("-a\n+A") },
				{ path: "same.txt", kind: { type: "update", move_path: null }, diff: expect.stringContaining("-A\n+AA") },
			],
		});
		expect(projection.diff.indexOf("-A\n+AA")).toBeGreaterThan(projection.diff.indexOf("-a\n+A"));
		expect(completed).toEqual({ item: projection.item, diff: projection.diff });
	});
});
