import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import { builtinExtensions } from "../../../src/core/extensions/builtin/index.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { TODO_STATE_ENTRY_TYPE, type TodoStateEntry } from "../../../src/core/extensions/builtin/todotools/state.ts";
import { emitSessionShutdownEvent } from "../../../src/core/extensions/runner.ts";
import type { ExtensionContext, ExtensionToolContext, ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";
import { ASYNC_QUESTIONS, type AskUserDelivery, createAskUserDelivery } from "../helpers/ask-user-delivery.ts";
import { renderWidget, shipPhases } from "../todo-liveness-harness.ts";

// senpi#1146 review: after a reload the watcher starts from what each input's owner re-publishes.

type WidgetFactory = (tui: TUI, theme: Theme) => Component;

const LIVE_BUILTINS = new Set(["session-liveness", "todowrite"]);
const deliveries: AskUserDelivery[] = [];

afterEach(() => {
	for (const delivery of deliveries.splice(0)) {
		for (const entry of getPendingQuestions(delivery.harness.session.sessionManager.getSessionId()))
			entry.cancel("session_closed");
		delivery.harness.cleanup();
	}
});

describe("todo widget across a reload (senpi#1146)", () => {
	it("keeps a question still pending after the reload ahead of a running child", async () => {
		const leading = builtinExtensions.filter(({ id }) => LIVE_BUILTINS.has(id)).map(({ factory }) => factory);
		const delivery = await createAskUserDelivery(30, leading);
		deliveries.push(delivery);
		const { session } = delivery.harness;
		session.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			schema: "v2",
			phases: shipPhases(),
		} satisfies TodoStateEntry);
		const widgets: Array<WidgetFactory | undefined> = [];
		const context = delivery.context(() => new Promise(() => {}));
		const setWidget = ((_key: string, content: unknown) => {
			widgets.push(typeof content === "function" ? (content as WidgetFactory) : undefined);
		}) as ExtensionUIContext["setWidget"];
		const ui = { ...context.ui, setWidget };
		const toolContext: ExtensionContext = { ...context, ui };
		const runner = delivery.harness.getExtensionRunner();
		runner.setUIContext(ui, "tui");
		await delivery.tool.execute(
			"pending-question",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			toolContext as ExtensionToolContext,
		);

		await emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "reload" });
		runner.setUIContext(ui, "tui");
		await runner.emit({ type: "session_start", reason: "reload" });
		runner.emitBusEvent(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });

		expect(getPendingQuestions(session.sessionManager.getSessionId())).toHaveLength(1);
		expect(renderWidget(widgets.at(-1))).toContain("[ ] Open the pull request");
		expect(renderWidget(widgets.at(-1))).not.toContain("[•]");
	});
});
