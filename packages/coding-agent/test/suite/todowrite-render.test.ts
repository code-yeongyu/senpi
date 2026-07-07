import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import type { TodoItem } from "../../src/core/extensions/builtin/todotools/index.ts";
import todowriteExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const tempRoots: string[] = [];

beforeAll(() => initTheme("dark"));

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function renderTodoWriteCall(todos: TodoItem[]): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "todowrite-render-"));
	tempRoots.push(root);
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		todowriteExtension,
		root,
		createEventBus(),
		runtime,
		"<builtin:todowrite>",
	);
	const sessionManager = SessionManager.inMemory(root);
	const modelRegistry = ModelRegistry.create(AuthStorage.create(join(root, "auth.json")), root);
	const runner = new ExtensionRunner([extension], runtime, root, sessionManager, modelRegistry);
	const tool = runner.getAllRegisteredTools().find((registeredTool) => registeredTool.definition.name === "todowrite");
	if (!tool?.definition.renderCall) throw new Error("Expected todowrite renderCall to be registered");

	const args = { todos };
	const context: ToolRenderContext<undefined, typeof args> = {
		args,
		toolCallId: "tool-todo",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: root,
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
	const component = tool.definition.renderCall(args, theme, context);
	return stripAnsi(component.render(100).join("\n"));
}

describe("todowrite renderer", () => {
	it("renders todo contents in the call title when todos are updated", async () => {
		const rendered = await renderTodoWriteCall([
			{
				content:
					"packages/coding-agent/src/core/extensions/builtin/todotools/tools/todowrite.ts: Show todo contents - expect visible rows",
				status: "in_progress",
				priority: "high",
			},
			{
				content: "packages/coding-agent/test/suite/todowrite-render.test.ts: Add regression - expect failure first",
				status: "pending",
				priority: "medium",
			},
		]);

		expect(rendered).toContain("todowrite");
		expect(rendered).toContain("[•] packages/coding-agent/src/core/extensions/builtin/todotools/tools/todowrite.ts");
		expect(rendered).toContain("Show todo");
		expect(rendered).toContain("contents - expect visible rows");
		expect(rendered).toContain("[ ] packages/coding-agent/test/suite/todowrite-render.test.ts: Add regression");
		expect(rendered).not.toContain("item(s)");
	});

	it("sanitizes multiline and control-character todo content in the call title", async () => {
		const rendered = await renderTodoWriteCall([
			{
				content: "packages/coding-agent/src/core/extensions/builtin/todotools/state.ts:\nNormalize\u0000 todo text",
				status: "pending",
				priority: "high",
			},
		]);

		expect(rendered).toContain(
			"[ ] packages/coding-agent/src/core/extensions/builtin/todotools/state.ts: Normalize todo text",
		);
		expect(rendered).not.toContain("\u0000");
		expect(rendered).not.toContain("\nNormalize");
	});
});
