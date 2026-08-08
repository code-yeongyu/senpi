import { Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { nextToolOutputMode } from "../src/modes/interactive/components/tool-execution-types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function selfRenderedTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: "dedicated renderer fixture",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderShell: "self",
		renderCall: () => new Text(`dedicated:${name}`, 0, 0),
	};
}

function atomicTool(
	name: string,
	args: unknown,
	toolDefinition?: ToolDefinition,
	trustedBuiltIn = true,
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		name,
		name,
		args,
		{ outputMode: "atomic", trustedBuiltIn },
		toolDefinition,
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

describe("atomic tool rows", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("cycles collapsed through expanded and atomic", () => {
		expect(nextToolOutputMode("collapsed")).toBe("expanded");
		expect(nextToolOutputMode("expanded")).toBe("atomic");
		expect(nextToolOutputMode("atomic")).toBe("collapsed");
	});

	test("renders a full-width single line without horizontal padding", () => {
		const component = atomicTool("read", { path: "src/index.ts" });
		component.updateResult(textResult("hidden\ncontent", { truncation: { totalLines: 240 } }));

		const lines = component.render(48);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBe(48);
		expect(stripAnsi(lines[0]!).startsWith("read src/index.ts · 240 lines")).toBe(true);
		expect(lines[0]).toContain(theme.fg("toolTitle", theme.bold("read")));
	});

	test("keeps Bash and Eval maxima after their spinners stop", () => {
		vi.useFakeTimers();
		try {
			const bash = atomicTool("bash", { command: "bun test" });
			bash.markExecutionStarted();
			bash.updateResult(textResult(Array.from({ length: 18 }, (_, index) => `line ${index}`).join("\n")), true);
			expect(stripAnsi(bash.render(60)[0]!).startsWith("bash ⠋ bun test · 18 lines")).toBe(true);

			vi.advanceTimersByTime(160);
			expect(stripAnsi(bash.render(60)[0]!).startsWith("bash ⠙ bun test · 18 lines")).toBe(true);

			bash.updateResult(textResult("done"));
			expect(stripAnsi(bash.render(60)[0]!).startsWith("bash bun test · 18 lines")).toBe(true);

			const evalTool = atomicTool("eval", { title: "Inspect source" });
			evalTool.markExecutionStarted();
			evalTool.updateResult(textResult("", { toolCalls: Array.from({ length: 8 }, () => ({})) }), true);
			expect(stripAnsi(evalTool.render(60)[0]!).startsWith("eval Inspect source · ⠋ 8 calls")).toBe(true);
			evalTool.updateResult(textResult("", { toolCalls: [] }));
			expect(stripAnsi(evalTool.render(60)[0]!).startsWith("eval Inspect source · 8 calls")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("makes Eval target spoofing unambiguous without changing metadata order", () => {
		const component = atomicTool("eval", { title: "Inspect · ⠋ 99 calls" });
		component.markExecutionStarted();
		component.updateResult(textResult("", { toolCalls: Array.from({ length: 2 }, () => ({})) }), true);

		expect(stripAnsi(component.render(80)[0]!).startsWith("eval Inspect ∙ ⠋ 99 calls · ⠋ 2 calls")).toBe(true);
	});

	test.each([1.5, Number.MAX_SAFE_INTEGER + 1, -1])("rejects invalid authoritative count %s", (totalLines) => {
		const component = atomicTool("read", { path: "fixture.ts" });
		component.updateResult(textResult("hidden", { truncation: { totalLines } }));

		const line = stripAnsi(component.render(80)[0]!);
		expect(line).toContain("read fixture.ts");
		expect(line).not.toContain(`${totalLines} line`);
	});

	test.each([1.5, Number.MAX_SAFE_INTEGER + 1, -1])(
		"falls back to observed Bash lines for invalid authoritative count %s",
		(totalLines) => {
			const component = atomicTool("bash", { command: "printf output" });
			component.updateResult(textResult("first\nsecond", { truncation: { totalLines } }));

			expect(stripAnsi(component.render(80)[0]!).startsWith("bash printf output · 2 lines")).toBe(true);
		},
	);

	test("refreshes metadata when argument and result objects are reused", () => {
		const args = { path: "first.ts" };
		const component = atomicTool("read", args);
		expect(stripAnsi(component.render(80)[0]!)).toContain("first.ts");

		args.path = "second.ts";
		component.updateArgs(args);
		expect(stripAnsi(component.render(80)[0]!)).toContain("second.ts");

		const details = { truncation: { totalLines: 4 } };
		const result = textResult("line", details);
		component.updateResult(result);
		expect(stripAnsi(component.render(80)[0]!)).toContain("4 lines");

		details.truncation.totalLines = 9;
		component.updateResult(result);
		expect(stripAnsi(component.render(80)[0]!)).toContain("9 lines");
	});

	test("shows unique cross-platform apply_patch basenames", () => {
		const component = atomicTool("apply_patch", {
			input: ["*** Begin Patch", "*** Update File: src/a.ts", "*** Update File: test\\a.ts", "*** End Patch"].join(
				"\n",
			),
		});
		component.updateResult(textResult("Done!"));

		const line = stripAnsi(component.render(64)[0]!);
		expect(line).toContain("apply_patch a.ts");
		expect(line.match(/a\.ts/gu)).toHaveLength(1);
		expect(line).not.toContain("src/");
		expect(line).not.toContain("test\\");
	});

	test.each(["monitor", "todo", "create_goal", "get_goal", "update_goal"])(
		"keeps %s on its existing renderer",
		(name) => {
			const component = atomicTool(name, { op: "view" }, selfRenderedTool(name));
			component.updateResult(textResult("task one\ntask two"));

			expect(stripAnsi(component.render(48).join("\n"))).toContain(`dedicated:${name}`);
		},
	);

	test("does not infer authoritative facts from unknown extension details", () => {
		const component = atomicTool("custom_tool", { name: "fixture" });
		component.updateResult(textResult("ok", { status: "complete", items: [{}, {}] }));

		const line = stripAnsi(component.render(80)[0]!);
		expect(line).toContain("custom_tool fixture");
		expect(line).not.toContain("complete");
		expect(line).not.toContain("2 items");
	});

	test("escapes target delimiters and preserves trusted facts at narrow widths", () => {
		const component = atomicTool("read", { path: "deploy · exit 0.ts" });
		component.updateResult(textResult("ok", { truncation: { totalLines: 240 } }));

		const line = stripAnsi(component.render(32)[0]!);
		expect(line).toContain("deploy ∙");
		expect(line).toContain("240 lines");
		expect(line).not.toContain("deploy · exit 0");
	});

	test("does not trust built-in names for extension overrides", () => {
		const todo = atomicTool("todo", { name: "fixture" }, selfRenderedTool("todo"), false);
		todo.updateResult(textResult("ok", { status: "complete", items: [{}, {}] }));
		const todoLine = stripAnsi(todo.render(80)[0]!);
		expect(todoLine).toContain("todo fixture");
		expect(todoLine).not.toContain("dedicated:todo");
		expect(todoLine).not.toContain("complete");
		expect(todoLine).not.toContain("2 items");

		const read = atomicTool("read", { path: "fixture.ts" }, selfRenderedTool("read"), false);
		read.updateResult(textResult("ok", { truncation: { totalLines: 240 } }));
		expect(stripAnsi(read.render(80)[0]!)).not.toContain("240 lines");
	});

	test("does not execute hidden extension renderers in atomic mode", () => {
		const renderCall = vi.fn(() => new Text("extension renderer", 0, 0));
		const definition = { ...selfRenderedTool("custom_tool"), renderCall };
		const component = atomicTool("custom_tool", { name: "fixture" }, definition, false);

		expect(renderCall).not.toHaveBeenCalled();
		component.setOutputMode("expanded");
		expect(renderCall).toHaveBeenCalledOnce();
	});

	test("disposes extension renderer state when entering atomic mode", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const disposeRenderState = vi.fn((state: { interval?: NodeJS.Timeout }) => {
			if (state.interval) clearInterval(state.interval);
			state.interval = undefined;
		});
		const definition: ToolDefinition<ReturnType<typeof Type.Any>, unknown, { interval?: NodeJS.Timeout }> = {
			name: "custom_tool",
			label: "custom_tool",
			description: "renderer lifecycle fixture",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("extension call", 0, 0),
			renderResult: (_result, _options, _theme, context) => {
				context.state.interval ??= setInterval(context.invalidate, 100);
				return new Text("extension result", 0, 0);
			},
			disposeRenderState,
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"custom-tool-state",
			{},
			{ trustedBuiltIn: false },
			definition,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult(textResult("working"), true);
		component.setOutputMode("atomic");
		requestRender.mockClear();
		vi.advanceTimersByTime(200);

		expect(disposeRenderState).toHaveBeenCalledOnce();
		expect(requestRender).not.toHaveBeenCalled();
		component.dispose();
		vi.useRealTimers();
	});

	test("restores extension self-renderers after leaving atomic mode", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"custom-tool",
			{},
			{},
			selfRenderedTool("custom_tool"),
			{ requestRender: () => {} } as TUI,
			process.cwd(),
		);

		expect(stripAnsi(component.render(48).join("\n"))).toContain("dedicated:custom_tool");
		component.setOutputMode("atomic");
		expect(stripAnsi(component.render(48).join("\n"))).not.toContain("dedicated:custom_tool");
		component.setOutputMode("expanded");
		expect(stripAnsi(component.render(48).join("\n"))).toContain("dedicated:custom_tool");
	});
});
