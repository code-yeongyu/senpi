import { describe, expect, it } from "vitest";
import { createBashOutputTool } from "../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalToolContext } from "../src/core/extensions/builtin/terminal/tools/context.ts";

/**
 * bash_output is a pure non-blocking peek: it returns the latest delta, the
 * status line, or a rendered screen snapshot without ever waiting.
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
	it("distinguishes an already-read delta from unread lines that do not match the filter", async () => {
		const runtime = new FakeRuntime();
		const tool = createFixture(runtime);
		runtime.emit("already shown");
		runtime.readDelta();
		const read = () => tool.execute("peek", { bash_id: "bash-1", filter: "needle" });
		expect(firstText(await read())).toContain("no unread output to filter");
		runtime.emit("something else");
		expect(firstText(await read())).toContain("no new output lines matched");
	});

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
