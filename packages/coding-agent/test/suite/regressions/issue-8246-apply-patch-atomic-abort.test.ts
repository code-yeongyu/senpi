import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerApplyPatchExtension } from "../../../src/core/extensions/builtin/gpt-apply-patch/extension.ts";
import { createApplyPatchTool } from "../../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type { ApplyPatchToolDetails } from "../../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const originals = {
	"update.txt": Buffer.from("u\r\n"),
	"delete.txt": Buffer.from("d\r\n"),
	"tail.txt": Buffer.from("t\r\n"),
};
const patch = `*** Begin Patch
*** Update File: update.txt
@@
-u
+U
*** Delete File: delete.txt
*** Update File: tail.txt
@@
-t
+T
*** End Patch`;
const tempDirs: string[] = [];
const harnesses: Harness[] = [];

async function seedFiles(cwd: string): Promise<void> {
	await Promise.all(Object.entries(originals).map(([name, bytes]) => writeFile(path.join(cwd, name), bytes)));
}

function snapshot(cwd: string): Record<string, Buffer | null> {
	return Object.fromEntries(
		Object.keys(originals).map((name) => {
			try {
				return [name, readFileSync(path.join(cwd, name))];
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
					return [name, null];
				}
				throw error;
			}
		}),
	);
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await Promise.all(tempDirs.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

// https://github.com/code-yeongyu/oh-my-openagent/issues/8246
describe("apply_patch cancellation is byte-exact and atomic", () => {
	it("restores CRLF updates and deletions when aborted after two applied operations", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "senpi-8246-"));
		tempDirs.push(cwd);
		await seedFiles(cwd);
		const controller = new AbortController();
		const tool = createApplyPatchTool();
		const applied: number[] = [];

		await tool.execute(
			"abort-after-delete",
			{ input: patch },
			controller.signal,
			(update) => {
				const progress = update.details?.progress;
				if (!progress) return;
				applied.push(progress.applied);
				if (progress.applied === 2) controller.abort();
			},
			{ cwd } as Parameters<typeof tool.execute>[4],
		);

		expect(controller.signal.aborted).toBe(true);
		expect(applied).toContain(2);
		// Compare raw buffers: restoring LF text is not restoring the original CRLF bytes.
		expect(snapshot(cwd)).toEqual(originals);
	});

	it("does not mutate files or emit applied progress for a pre-aborted signal", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "senpi-8246-pre-aborted-"));
		tempDirs.push(cwd);
		await seedFiles(cwd);
		const controller = new AbortController();
		controller.abort();
		const tool = createApplyPatchTool();
		const applied: number[] = [];

		await tool.execute(
			"pre-aborted",
			{ input: patch },
			controller.signal,
			(update) => {
				const count = update.details?.progress?.applied;
				if (count !== undefined && count > 0) applied.push(count);
			},
			{ cwd } as Parameters<typeof tool.execute>[4],
		);

		expect(snapshot(cwd)).toEqual(originals);
		expect(applied).toEqual([]);
	});

	it("restores original bytes before the agent-loop-visible final tool result", async () => {
		const executions: ReturnType<ReturnType<typeof createApplyPatchTool>["execute"]>[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerApplyPatchExtension({
						...pi,
						registerTool(tool) {
							pi.registerTool({
								...tool,
								execute(...args) {
									const execution = tool.execute(...args);
									executions.push(execution);
									return execution;
								},
							});
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.setActiveToolsByName(["apply_patch"]);
		await seedFiles(harness.tempDir);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("apply_patch", { input: patch }), { stopReason: "toolUse" }),
		]);
		let aborted = false;
		let finalSnapshot: ReturnType<typeof snapshot> | undefined;
		// Subscribe before execution and snapshot synchronously at the observable result boundary.
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && event.toolName === "apply_patch") {
				const details = event.partialResult.details as ApplyPatchToolDetails | undefined;
				if (details?.progress?.applied === 2 && !aborted) {
					aborted = true;
					harness.agent.abort();
				}
			}
			if (event.type === "tool_execution_end" && event.toolName === "apply_patch") {
				finalSnapshot = snapshot(harness.tempDir);
			}
		});
		try {
			await harness.session.prompt("Apply the patch");
			expect(aborted).toBe(true);
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
			expect(finalSnapshot).toEqual(originals);
		} finally {
			unsubscribe();
			// The pre-fix agent loop abandons execute on abort; drain it before removing fixtures.
			await Promise.all(executions);
		}
	}, 15_000);
});
