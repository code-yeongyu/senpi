import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { ToolOutputMode } from "../src/modes/interactive/components/tool-execution-types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createTool(name: string, id: string): ToolExecutionComponent {
	return new ToolExecutionComponent(name, id, {}, {}, undefined, { requestRender: () => {} } as TUI, process.cwd());
}

class ExpandableContainer extends Container {
	readonly setExpanded = vi.fn();
}

describe("tool output mode propagation", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("preserves top-level expansion ownership while updating nested and pending tools", () => {
		const direct = createTool("read", "direct");
		const nested = createTool("bash", "nested");
		const pending = createTool("eval", "pending");
		const wrapper = new ExpandableContainer();
		wrapper.addChild(nested);
		const chatContainer = new Container();
		chatContainer.addChild(direct);
		chatContainer.addChild(wrapper);

		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Reflect.set(mode, "toolOutputMode", "collapsed");
		Reflect.set(mode, "builtInHeader", undefined);
		Reflect.set(mode, "loadedResourcesContainer", new Container());
		Reflect.set(mode, "chatContainer", chatContainer);
		Reflect.set(
			mode,
			"pendingTools",
			new Map([
				["nested", nested],
				["pending", pending],
			]),
		);
		Reflect.set(mode, "showStatus", vi.fn());

		const directMode = vi.spyOn(direct, "setOutputMode");
		const nestedMode = vi.spyOn(nested, "setOutputMode");
		const pendingMode = vi.spyOn(pending, "setOutputMode");
		const setMode = Reflect.get(InteractiveMode.prototype, "setToolOutputMode") as (
			this: InteractiveMode,
			outputMode: ToolOutputMode,
		) => void;

		setMode.call(mode, "expanded");
		setMode.call(mode, "atomic");
		setMode.call(mode, "collapsed");

		for (const setOutputMode of [directMode, nestedMode, pendingMode]) {
			expect(setOutputMode.mock.calls).toEqual([["expanded"], ["atomic"], ["collapsed"]]);
		}
		expect(wrapper.setExpanded.mock.calls).toEqual([[true], [false], [false]]);
	});
});
