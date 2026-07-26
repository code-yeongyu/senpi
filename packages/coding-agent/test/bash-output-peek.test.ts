import { describe, expect, it } from "vitest";
import {
	BASH_OUTPUT_WAIT_REMOVED_GUIDANCE,
	bashOutputSchema,
	createBashOutputTool,
} from "../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalToolContext } from "../src/core/extensions/builtin/terminal/tools/context.ts";

/**
 * bash_output is a pure non-blocking peek: it never waits for output, and the
 * removed blocking params (wait_for / block / timeout) survive only as ghost
 * params that return migration guidance pointing at monitor + notifications.
 */
class FakeRuntime {
	exited = false;
	exitResult: { exitCode: number | null } | null = null;
	#output = "";

	readDelta(): { text: string; droppedChars: number } {
		const text = this.#output;
		this.#output = "";
		return { text, droppedChars: 0 };
	}

	snapshot(): { visibleGrid: string[] } {
		return { visibleGrid: ["screen-row-1", "screen-row-2"] };
	}

	emit(text: string): void {
		this.#output += text;
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

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("bash_output peek", () => {
	it("returns status and new output immediately", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		runtime.emit("line one\nline two\n");
		const result = await tool.execute("call-1", { bash_id: "bash-1" });
		expect(result.isError).toBeFalsy();
		expect(firstText(result)).toBe("status: running\nline one\nline two");
	});

	it("reports (no new output) when nothing arrived since the last read", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		const result = await tool.execute("call-2", { bash_id: "bash-1" });
		expect(firstText(result)).toBe("status: running\n(no new output)");
	});

	it("applies the filter regex to peeked output", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		runtime.emit("drop this\nkeep this\n");
		const result = await tool.execute("call-3", { bash_id: "bash-1", filter: "keep" });
		expect(firstText(result)).toContain("keep this");
		expect(firstText(result)).not.toContain("drop this");
	});

	it("renders the screen view without blocking", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		const result = await tool.execute("call-4", { bash_id: "bash-1", view: "screen" });
		expect(firstText(result)).toContain("screen-row-1");
		expect(firstText(result)).toContain("screen-row-2");
	});

	it("reports exit status for a finished session", async () => {
		const runtime = new FakeRuntime();
		runtime.exited = true;
		runtime.exitResult = { exitCode: 3 };
		const tool = createFixture(runtime);
		const result = await tool.execute("call-5", { bash_id: "bash-1" });
		expect(firstText(result)).toContain("exit_code: 3");
	});

	it("errors for an unknown bash_id", async () => {
		const tool = createFixture(new FakeRuntime());
		const result = await tool.execute("call-6", { bash_id: "bash-404" });
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("bash-404");
	});

	it("never blocks even when the session stays silent", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		const execution = tool.execute("call-7", { bash_id: "bash-1" });
		const result = await Promise.race([
			execution,
			new Promise((_, reject) => setTimeout(() => reject(new Error("peek blocked for over 1s")), 1000)),
		]);
		expect(firstText(result as Awaited<typeof execution>)).toContain("status: running");
	});
});

describe("bash_output removed blocking params", () => {
	it("wait_for returns ghost guidance naming monitor", async () => {
		const tool = createFixture(new FakeRuntime());
		const result = await tool.execute("call-8", { bash_id: "bash-1", wait_for: "DONE" });
		expect(result.isError).toBe(true);
		const text = firstText(result);
		expect(text).toBe(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE);
		expect(text).toContain("wait_for removed");
		expect(text).toContain("monitor(");
	});

	it("a blocking timeout returns the same ghost guidance", async () => {
		const tool = createFixture(new FakeRuntime());
		const result = await tool.execute("call-9", { bash_id: "bash-1", timeout: 30 });
		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE);
	});

	it("block returns the same ghost guidance", async () => {
		const tool = createFixture(new FakeRuntime());
		const result = await tool.execute("call-10", { bash_id: "bash-1", block: true });
		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE);
	});

	it("guidance covers the monitor launch pattern, the already-running fallback, and the notification tail", () => {
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("monitor({command, filter})");
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("already-running");
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("kill_bash");
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("notifications carry the tail");
	});

	it("keeps the removed params in the schema only as deprecated ghosts", () => {
		const properties = bashOutputSchema.properties as Record<string, { description?: string }>;
		for (const key of ["wait_for", "block", "timeout"]) {
			expect(Object.hasOwn(properties, key), `schema keeps ghost param ${key}`).toBe(true);
			expect(properties[key]?.description?.toLowerCase()).toContain("removed");
		}
	});
});
