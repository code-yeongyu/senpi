import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionRenderer } from "../src/modes/interactive/components/tool-execution-renderer.ts";
import type {
	ToolExecutionIdentity,
	ToolExecutionRenderState,
} from "../src/modes/interactive/components/tool-execution-types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createToolDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "custom_tool",
		label: "custom_tool",
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [], details: {} }),
		...overrides,
	};
}

function createIdentity(toolDefinition: ToolDefinition, trustedBuiltIn = false): ToolExecutionIdentity {
	return {
		toolName: toolDefinition.name,
		toolCallId: "tool-lifecycle",
		cwd: process.cwd(),
		toolDefinition,
		trustedBuiltIn,
	};
}

function createState(result = false): ToolExecutionRenderState {
	return {
		args: {},
		executionStarted: result,
		argsComplete: result,
		isPartial: !result,
		expanded: false,
		showImages: true,
		spinnerFrame: undefined,
		result: result ? { content: [{ type: "text", text: "done" }], details: {}, isError: false } : undefined,
	};
}

function createComponent(text: string, dispose: () => void): Component {
	return {
		render: () => [text],
		invalidate: () => {},
		dispose,
	};
}

describe("ToolExecutionRenderer lifecycle", () => {
	beforeAll(() => initTheme("dark"));

	test("disposes a failed renderer component exactly once even when both slots share it", () => {
		const dispose = vi.fn();
		const failedComponent: Component = {
			render: () => {
				throw new Error("render failed");
			},
			invalidate: () => {},
			dispose,
		};
		const toolDefinition = createToolDefinition({
			renderCall: () => failedComponent,
			renderResult: () => failedComponent,
		});
		const state = createState(true);
		const renderer = new ToolExecutionRenderer(createIdentity(toolDefinition), state, () => {});

		renderer.update(state);
		expect(stripAnsi(renderer.render(120).join("\n"))).toContain("custom_tool");
		renderer.suspend();
		renderer.dispose();

		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test("keeps suspend idempotent until the renderer is updated", () => {
		const disposeRenderState = vi.fn();
		const componentDisposals: ReturnType<typeof vi.fn>[] = [];
		const toolDefinition = createToolDefinition({
			disposeRenderState,
			renderCall: () => {
				const dispose = vi.fn();
				componentDisposals.push(dispose);
				return createComponent(`generation ${componentDisposals.length}`, dispose);
			},
		});
		const state = createState(true);
		const renderer = new ToolExecutionRenderer(createIdentity(toolDefinition), state, () => {});

		renderer.update(state);
		renderer.suspend();
		renderer.suspend();
		expect(disposeRenderState).toHaveBeenCalledTimes(1);
		expect(componentDisposals).toHaveLength(1);
		expect(componentDisposals[0]).toHaveBeenCalledTimes(1);

		renderer.update(state);
		renderer.suspend();
		renderer.dispose();
		expect(disposeRenderState).toHaveBeenCalledTimes(2);
		expect(componentDisposals).toHaveLength(2);
		expect(componentDisposals[1]).toHaveBeenCalledTimes(1);
	});

	test("contains cleanup failures while detaching and disposing every component", () => {
		vi.useFakeTimers();
		try {
			const callDispose = vi.fn(() => {
				throw new Error("call disposal failed");
			});
			const resultDispose = vi.fn();
			const disposeRenderState = vi.fn(() => {
				throw new Error("custom cleanup failed");
			});
			const toolDefinition = createToolDefinition({
				name: "bash",
				disposeRenderState,
				renderCall: (_args, _theme, context) => {
					Reflect.set(
						context.state,
						"interval",
						setInterval(() => {}, 1_000),
					);
					return createComponent("custom call", callDispose);
				},
				renderResult: () => createComponent("custom result", resultDispose),
			});
			const state = createState(true);
			const renderer = new ToolExecutionRenderer(createIdentity(toolDefinition, true), state, () => {});

			renderer.update(state);
			expect(vi.getTimerCount()).toBe(1);
			expect(stripAnsi(renderer.render(120).join("\n"))).toContain("custom call");
			expect(stripAnsi(renderer.render(120).join("\n"))).toContain("custom result");

			expect(() => renderer.suspend()).not.toThrow();
			expect(vi.getTimerCount()).toBe(0);
			expect(disposeRenderState).toHaveBeenCalledTimes(1);
			expect(callDispose).toHaveBeenCalledTimes(1);
			expect(resultDispose).toHaveBeenCalledTimes(1);
			const suspendedOutput = stripAnsi(renderer.render(120).join("\n"));
			expect(suspendedOutput).not.toContain("custom call");
			expect(suspendedOutput).not.toContain("custom result");
			expect(() => renderer.dispose()).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});

	test("contains throwing dispose accessors and continues disposing components", () => {
		const resultDispose = vi.fn();
		const callComponent = createComponent("custom call", vi.fn());
		Object.defineProperty(callComponent, "dispose", {
			get: () => {
				throw new Error("dispose accessor failed");
			},
		});
		const toolDefinition = createToolDefinition({
			renderCall: () => callComponent,
			renderResult: () => createComponent("custom result", resultDispose),
		});
		const state = createState(true);
		const renderer = new ToolExecutionRenderer(createIdentity(toolDefinition), state, () => {});

		renderer.update(state);

		expect(() => renderer.suspend()).not.toThrow();
		expect(resultDispose).toHaveBeenCalledTimes(1);
	});
});
