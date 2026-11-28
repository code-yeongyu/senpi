import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { builtinExtensions } from "../../../src/core/extensions/builtin/index.ts";
import { connectSessionLiveness } from "../../../src/core/extensions/builtin/session-liveness/connect.ts";
import { TODO_STATE_ENTRY_TYPE, type TodoStateEntry } from "../../../src/core/extensions/builtin/todotools/state.ts";
import { noOpUIContext } from "../../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";
import { renderWidget, shipPhases } from "../todo-liveness-harness.ts";

// senpi#1146 review: the todo widget consumes the session's liveness only where it can be shown (`ctx.hasUI`); a
// one-shot print or json run neither polls nor reads the child-task records, while an RPC session still draws it.

type WidgetFactory = (tui: TUI, theme: Theme) => Component;

const POLL_MS = 4000;
const LIVE_BUILTINS = new Set(["session-liveness", "todowrite"]);
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function todoSession(probe?: (pi: ExtensionAPI) => void): Promise<Harness> {
	const builtins = builtinExtensions.filter(({ id }) => LIVE_BUILTINS.has(id)).map(({ factory }) => factory);
	const harness = await createHarness({ extensionFactories: probe ? [...builtins, probe] : builtins });
	harnesses.push(harness);
	const tasks = join(harness.tempDir, ".omo", "senpi-task", "tasks");
	mkdirSync(tasks, { recursive: true });
	const record = { status: "running", parent_session_id: harness.session.sessionManager.getSessionId() };
	writeFileSync(join(tasks, "child.json"), JSON.stringify(record));
	return harness;
}

describe("todo widget liveness outside the TUI (senpi#1146)", () => {
	it.each(["text", "json"] as const)(
		"a %s print run that uses the todo tool neither polls nor reads the child records",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const setInterval = vi.spyOn(globalThis, "setInterval");
			// Reads the fold without subscribing: a count above zero means something scanned the child records.
			let childCount: number | undefined;
			const harness = await todoSession((pi) => {
				pi.on("agent_settled", () => {
					childCount = connectSessionLiveness(pi.events)?.state().childCount;
				});
			});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("todo", { op: "init", list: [{ phase: "Ship", items: ["a", "b"] }] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const runtime = new AgentSessionRuntime(
				harness.session,
				{
					cwd: harness.tempDir,
					agentDir: join(harness.tempDir, "agent"),
					authStorage: harness.authStorage,
					modelRegistry: harness.modelRegistry,
					modelRuntime: getModelRuntime(harness.modelRegistry),
					settingsManager: harness.settingsManager,
					resourceLoader: createTestResourceLoader(),
					diagnostics: [],
				},
				async () => {
					throw new Error("This scenario does not replace the runtime");
				},
			);

			expect(await runPrintMode(runtime, { mode, initialMessage: "plan it" })).toBe(0);
			const todoEntries = harness.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE);
			expect(todoEntries.length).toBeGreaterThan(0);
			expect(childCount).toBe(0);
			expect(setInterval.mock.calls.filter(([, ms]) => ms === POLL_MS)).toEqual([]);
		},
	);

	it("an RPC session still draws the paused list and the active mark", async () => {
		const harness = await todoSession();
		harness.session.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			schema: "v2",
			phases: shipPhases(),
		} satisfies TodoStateEntry);
		const widgets: Array<WidgetFactory | undefined> = [];
		const setWidget = ((key: string, content: unknown) => {
			if (key === "todo-sidebar")
				widgets.push(typeof content === "function" ? (content as WidgetFactory) : undefined);
		}) as ExtensionUIContext["setWidget"];
		await harness.session.bindExtensions({});
		const runner = harness.getExtensionRunner();
		runner.setUIContext({ ...noOpUIContext, setWidget }, "rpc");
		await runner.emit({ type: "session_start", reason: "startup" });

		// The running child record keeps the session working until it ends.
		expect(renderWidget(widgets.at(-1))).toContain("[•] Open the pull request");
		writeFileSync(
			join(harness.tempDir, ".omo", "senpi-task", "tasks", "child.json"),
			JSON.stringify({ status: "completed", parent_session_id: harness.session.sessionManager.getSessionId() }),
		);
		await runner.emit({ type: "agent_settled" });
		expect(renderWidget(widgets.at(-1))).not.toContain("[•]");
	});
});
