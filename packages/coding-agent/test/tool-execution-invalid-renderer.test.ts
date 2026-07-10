import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolRendererBoundary } from "../src/modes/interactive/components/tool-renderer-boundary.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createToolDefinition(): ToolDefinition {
	return {
		name: "custom_tool",
		label: "custom_tool",
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [], details: {} }),
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as TUI;
}

function render(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("ToolExecutionComponent invalid renderers", () => {
	beforeAll(() => initTheme("dark"));

	test("falls back when a call renderer returns a non-component", () => {
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => ({ toString: () => "invalid component" }));
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-invalid-call-renderer",
			{ value: "safe" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(render(component)).toContain("custom_tool");
		expect(render(component)).not.toContain("[render error: Box]");
	});

	test("falls back when a call renderer returns a primitive", () => {
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => "invalid component");
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-primitive-call-renderer",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(render(component)).toContain("custom_tool");
		expect(render(component)).not.toContain("[render error: Box]");
	});

	test("falls back when a result renderer returns a non-component", () => {
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => new Text("custom call", 0, 0));
		Reflect.set(toolDefinition, "renderResult", () => ({ toString: () => "invalid component" }));
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-invalid-result-renderer",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "safe result" }], details: {}, isError: false }, false);
		expect(render(component)).toContain("safe result");
		expect(render(component)).not.toContain("[render error: Box]");
	});

	test("falls back when a renderer throws before returning a component", () => {
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => {
			throw new Error("invalid renderer");
		});
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-throwing-call-renderer",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(render(component)).toContain("custom_tool");
		expect(render(component)).not.toContain("[render error: Box]");
	});

	test("falls back when a call component throws while rendering", () => {
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => ({
			render: () => {
				throw new Error("invalid render");
			},
			invalidate: () => {},
		}));
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-throwing-call-component",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(render(component)).toContain("custom_tool");
		expect(render(component)).not.toContain("[render error: Box]");
	});

	test("falls back when a result component becomes invalid before rendering", () => {
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => new Text("custom call", 0, 0));
		Reflect.set(toolDefinition, "renderResult", () => {
			let renderReads = 0;
			return {
				get render() {
					renderReads += 1;
					if (renderReads === 1) return () => ["invalid result"];
					throw new Error("invalid render getter");
				},
				invalidate: () => {},
			};
		});
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-invalidated-result-component",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "safe result" }], details: {}, isError: false }, false);
		expect(render(component)).toContain("safe result");
		expect(render(component)).not.toContain("[render error: Box]");
	});

	test("accepts callable components", () => {
		const callableComponent = Object.assign(() => undefined, {
			render: () => ["callable component"],
			invalidate: () => {},
		});
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => callableComponent);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-callable-component",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(render(component)).toContain("callable component");
	});

	test("copies renderer lines before adding them to the tool box", () => {
		let lineReads = 0;
		const rendererLines = new Proxy(["stable line"], {
			get(target, property, receiver) {
				if (property === "0") {
					lineReads += 1;
					if (lineReads > 1) throw new Error("line changed after validation");
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const toolDefinition = createToolDefinition();
		Reflect.set(toolDefinition, "renderCall", () => ({ render: () => rendererLines, invalidate: () => {} }));
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-mutable-render-lines",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(render(component)).toContain("stable line");
		expect(render(component)).not.toContain("[render error: Box]");
	});

	test("passes the previous component back to the renderer", () => {
		const firstComponent = new Text("first", 0, 0);
		const previousComponents: Array<Component | undefined> = [];
		let renderCount = 0;
		const toolDefinition = createToolDefinition();
		Reflect.set(
			toolDefinition,
			"renderCall",
			(_args: unknown, _theme: unknown, context: { lastComponent?: Component }) => {
				previousComponents.push(context.lastComponent);
				renderCount += 1;
				return renderCount === 1 ? firstComponent : new Text("second", 0, 0);
			},
		);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-previous-component",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateArgs({ value: "updated" });
		expect(previousComponents).toEqual([undefined, firstComponent]);
		expect(render(component)).toContain("second");
	});

	test("disposes a failed renderer component exactly once", () => {
		const dispose = vi.fn();
		const boundary = new ToolRendererBoundary(
			{
				render: () => {
					throw new Error("invalid render");
				},
				invalidate: () => {},
				dispose,
			},
			new Text("fallback", 0, 0),
			() => {},
		);

		expect(boundary.render(120).join("\n").trimEnd()).toBe("fallback");
		boundary.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
