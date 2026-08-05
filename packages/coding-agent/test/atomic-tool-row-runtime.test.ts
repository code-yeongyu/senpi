import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function atomicTool(name: string, args: unknown): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		name,
		name,
		args,
		{ outputMode: "atomic", trustedBuiltIn: true },
		undefined,
		{ requestRender: () => {} } as TUI,
		process.cwd(),
	);
	return component;
}

function textResult(text: string, details?: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		isError,
	};
}

describe("atomic tool row runtime boundaries", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("handles degenerate widths without overflow", () => {
		const component = new ToolExecutionComponent(
			"read",
			"read-narrow",
			{ path: "한글/😀.ts" },
			{},
			undefined,
			{ requestRender: () => {} } as TUI,
			process.cwd(),
			"grok",
		);
		component.setOutputMode("atomic");

		expect(component.render(0)).toEqual([]);
		expect(visibleWidth(component.render(1)[0]!)).toBe(1);
		expect(visibleWidth(component.render(2)[0]!)).toBe(2);
		expect(component.render(40)).toHaveLength(1);
	});

	test("strips bidirectional controls from untrusted labels", () => {
		const component = atomicTool("read", { path: "safe\u202eevil.ts\u2066" });

		expect(stripAnsi(component.render(48)[0]!)).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
	});

	test("bounds and memoizes apply_patch target extraction", () => {
		let inputReads = 0;
		const component = atomicTool("apply_patch", {
			get input() {
				inputReads++;
				return [
					"*** Begin Patch",
					"*** Update File: first.ts",
					"x".repeat(20_000),
					"*** Update File: late.ts",
					"*** End Patch",
				].join("\n");
			},
		});
		const readsAfterUpdate = inputReads;

		const line = stripAnsi(component.render(1024)[0]!);
		component.render(1024);

		expect(inputReads).toBe(readsAfterUpdate);
		expect(line).toContain("first.ts");
		expect(line).not.toContain("late.ts");
	});

	test("contains throwing metadata accessors", () => {
		const args = Object.defineProperty({}, "path", {
			get() {
				throw new Error("argument getter");
			},
		});
		const component = atomicTool("read", args);
		const content = Object.defineProperty({ type: "text" as const }, "text", {
			get() {
				throw new Error("result getter");
			},
		}) as { type: "text"; text: string };

		expect(() => component.updateResult({ content: [content], isError: false })).not.toThrow();
		expect(stripAnsi(component.render(80)[0]!)).toContain("read");
	});

	test("prefers Bash descriptions and concrete failures", () => {
		const component = atomicTool("bash", { description: "Run tests", command: "bun test" });
		component.markExecutionStarted();
		component.updateResult(textResult("failure\n\nCommand exited with code 7", undefined, true));

		const line = stripAnsi(component.render(64)[0]!);
		expect(line).toContain("bash Run tests · 1 line · exit 7");
		expect(line).not.toContain("bun test");
		expect(line).not.toContain("failed");
	});

	test("counts successful Bash output that resembles an error trailer", () => {
		const component = atomicTool("bash", { command: "printf trailer" });
		component.updateResult(textResult("Command exited with code 7"));

		const line = stripAnsi(component.render(64)[0]!);
		expect(line).toContain("1 line");
		expect(line).not.toContain("exit 7");
	});

	test("does not animate tools without a visible atomic spinner", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"apply_patch",
			"apply-patch-animation",
			{ input: "*** Begin Patch\n*** End Patch" },
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);

		component.setOutputMode("atomic");
		requestRender.mockClear();
		vi.advanceTimersByTime(100);

		expect(requestRender).not.toHaveBeenCalled();
		component.dispose();
	});

	test("stops hidden classic renderer progress while partial and after disposal", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			"bash-hidden-renderer",
			{ command: "bun test" },
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(textResult("working", { progress: { activity: "testing" } }), true);
		component.setOutputMode("atomic");
		requestRender.mockClear();

		vi.advanceTimersByTime(1_100);

		expect(requestRender).not.toHaveBeenCalled();
		component.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(1_100);
		expect(requestRender).not.toHaveBeenCalled();
	});

	test("marks bounded Bash line counts and preserves error trailers", () => {
		const component = atomicTool("bash", { command: "large-output" });
		const output = `${Array.from({ length: 9_000 }, (_, index) => `line ${index}`).join("\n")}\n\nCommand exited with code 7`;
		component.updateResult(textResult(output, undefined, true));

		const line = stripAnsi(component.render(200)[0]!);
		expect(line).toMatch(/\d+\+ lines · exit 7/u);
	});

	test("keeps bounded multi-block line counts as a true lower bound", () => {
		const component = atomicTool("bash", { command: "multi-block-output" });
		component.updateResult({
			content: Array.from({ length: 65 }, () => ({ type: "text" as const, text: "line" })),
			isError: false,
		});

		const line = stripAnsi(component.render(200)[0]!);
		const count = /(\d+)\+ lines/u.exec(line);
		expect(count).not.toBeNull();
		expect(Number(count?.[1])).toBeLessThanOrEqual(65);
	});
});
