import { describe, expect, it } from "vitest";
import { createBashOutputTool } from "../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalToolContext } from "../src/core/extensions/builtin/terminal/tools/context.ts";
import type { AgentToolResult } from "../src/core/extensions/types.ts";

type PartialUpdate = AgentToolResult<Record<string, unknown> | undefined>;

function textOf(update: PartialUpdate): string {
	const content = update.content.find((block) => block.type === "text");
	return content?.type === "text" ? content.text : "";
}

type OutputListener = (chunk: string) => void;
type WaitOutcome = "matched" | "exited" | "timeout" | "aborted" | "invalid_pattern";

class FakeRuntime {
	exited = false;
	exitResult: null = null;
	#output = "";
	#listeners = new Set<OutputListener>();
	#resolveWait: ((outcome: WaitOutcome) => void) | undefined;

	onOutput(listener: OutputListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	waitFor(_pattern: string, _timeoutMs: number, _signal?: AbortSignal): Promise<WaitOutcome> {
		return new Promise((resolve) => {
			this.#resolveWait = resolve;
		});
	}

	readDelta(): { text: string; droppedChars: number } {
		const text = this.#output;
		this.#output = "";
		return { text, droppedChars: 0 };
	}

	snapshot(): { visibleGrid: string[] } {
		return { visibleGrid: [] };
	}

	emit(text: string): void {
		this.#output += text;
		for (const listener of this.#listeners) listener(text);
	}

	finish(outcome: WaitOutcome = "matched"): void {
		this.#resolveWait?.(outcome);
	}
}

function createFixture(runtime: FakeRuntime) {
	const ctx = {
		manager: { get: (id: string) => (id === "bash-1" ? runtime : undefined) },
		cwd: process.cwd(),
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => process.env,
	} as unknown as TerminalToolContext;
	return createBashOutputTool(ctx);
}

describe("bash_output wait streaming", () => {
	it("emits immediate progress, filtered live tail updates, and preserves the final result", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		const updates: PartialUpdate[] = [];

		const execution = tool.execute(
			"call-1",
			{ bash_id: "bash-1", wait_for: "DONE", timeout: 12, filter: "keep" },
			undefined,
			(update) => updates.push(update),
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			content: [{ type: "text", text: "status: running" }],
			details: { progress: { activity: "waiting for /DONE/", maxWaitMs: 12_000 } },
		});

		runtime.emit("drop this\nkeep this\n");
		expect(updates).toHaveLength(2);
		expect(textOf(updates[1]!)).toContain("keep this");
		expect(textOf(updates[1]!)).not.toContain("drop this");

		runtime.emit("keep DONE\n");
		runtime.finish();
		await expect(execution).resolves.toEqual({
			content: [{ type: "text", text: "status: running\nkeep this\nkeep DONE" }],
			details: undefined,
		});

		const updateCount = updates.length;
		runtime.emit("keep after completion\n");
		expect(updates).toHaveLength(updateCount);
	});

	it("retains only a UTF-8-safe 64 KB tail for streamed previews", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		const updates: PartialUpdate[] = [];
		const execution = tool.execute("call-2", { bash_id: "bash-1", wait_for: "DONE" }, undefined, (update) =>
			updates.push(update),
		);

		runtime.emit(`old-${"a".repeat(70 * 1024)}\n`);
		runtime.emit("tail-🙂-DONE\n");
		runtime.finish();
		await execution;

		const finalUpdate = updates.at(-1);
		if (!finalUpdate) throw new Error("Expected a streamed update");
		const preview = textOf(finalUpdate);
		expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(
			64 * 1024 + Buffer.byteLength("status: running\n", "utf8"),
		);
		expect(preview).not.toContain("old-");
		expect(preview).toContain("tail-🙂-DONE");
	});
});
