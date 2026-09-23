import { stripVTControlCharacters } from "node:util";
import { Container, TUI } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "./harness.ts";

export function invoke(mode: InteractiveMode, name: string, ...args: unknown[]): unknown {
	const method = Reflect.get(mode, name);
	if (typeof method !== "function") throw new TypeError(`Missing interactive method: ${name}`);
	return method.apply(mode, args);
}

export async function explorationSurface(hideThinkingBlock = true) {
	const harness = await createHarness({ settings: { smoothStreaming: false, hideThinkingBlock } });
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	Reflect.set(mode, "isInitialized", true);
	Reflect.set(mode, "hideThinkingBlock", hideThinkingBlock);
	Reflect.set(mode, "getMarkdownTransformers", () => []);
	Reflect.set(mode, "handleToolExecutionStart", () => {});
	Reflect.set(mode, "handleToolExecutionEnd", () => {});
	Reflect.set(mode, "maybeShowAssistantDiagnostics", () => {});
	Reflect.set(mode, "maybeShowCacheMissNotice", () => {});
	Reflect.set(mode, "showStatus", () => {});
	const chat = Reflect.get(mode, "chatContainer");
	if (!(chat instanceof Container)) throw new TypeError("Expected the real transcript container");
	return {
		harness,
		mode,
		chat,
		event: async (event: AgentSessionEvent) => {
			await invoke(mode, "handleEvent", event);
		},
		text: (width = 120) => chat.render(width).map(stripVTControlCharacters).join("\n"),
		cleanup: () => {
			chat.dispose();
			ui.stop();
			harness.cleanup();
		},
	};
}

export type ExplorationStep = {
	readonly id: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;
	readonly output?: string;
	readonly isError?: boolean;
};

/** Drive one settled tool call through the real start/end event seam. */
export async function runTool(surface: Awaited<ReturnType<typeof explorationSurface>>, step: ExplorationStep) {
	await surface.event({ type: "tool_execution_start", toolCallId: step.id, toolName: step.toolName, args: step.args });
	await surface.event({
		type: "tool_execution_end",
		toolCallId: step.id,
		toolName: step.toolName,
		result: { content: [{ type: "text", text: step.output ?? `original-result-${step.id}` }] },
		isError: step.isError ?? false,
	});
}
