import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

type ToolHookStatusEvent = Extract<AgentSessionEvent, { type: "tool_hook_status" }>;

type HookStatusPrototype = {
	handleEvent(this: HookStatusThis, event: ToolHookStatusEvent): Promise<void>;
	handleToolHookStatusEvent(this: HookStatusThis, event: ToolHookStatusEvent): void;
	refreshToolHookStatuses(this: HookStatusThis): void;
};

type HookStatusThis = {
	isInitialized: boolean;
	footer: { invalidate(): void };
	activeToolHooks: Map<string, Extract<ToolHookStatusEvent, { phase: "start" }>>;
	hookStatusContainer: Container;
	startToolHookStatusTimer(): void;
	stopToolHookStatusTimer(): void;
	refreshToolHookStatuses(): void;
	handleToolHookStatusEvent(event: ToolHookStatusEvent): void;
	ui: { requestRender(): void };
};

function renderHookStatus(container: Container): string {
	return stripAnsi(container.children.flatMap((child) => child.render(120)).join("\n"))
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

describe("InteractiveMode hook status events", () => {
	const now = new Date("2026-05-19T08:00:00.000Z").getTime();

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("renders and clears live hook status rows with elapsed time", async () => {
		vi.useFakeTimers({ now });
		const prototype = InteractiveMode.prototype as unknown as HookStatusPrototype;
		const hookStatusContainer = new Container();
		const fakeThis: HookStatusThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeToolHooks: new Map(),
			hookStatusContainer,
			startToolHookStatusTimer: vi.fn(),
			stopToolHookStatusTimer: vi.fn(),
			refreshToolHookStatuses: prototype.refreshToolHookStatuses,
			handleToolHookStatusEvent: prototype.handleToolHookStatusEvent,
			ui: { requestRender: vi.fn() },
		};

		await prototype.handleEvent.call(fakeThis, {
			type: "tool_hook_status",
			phase: "start",
			hookRunId: "run-1",
			hookName: "PostToolUse",
			toolName: "bash",
			toolCallId: "call-1",
			extensionPath: "<builtin:permission-system>",
			statusMessage: "matching project rules",
			startedAt: now - 7_000,
		});

		expect(renderHookStatus(hookStatusContainer)).toContain("Running PostToolUse hook: matching project rules (7s)");
		expect(fakeThis.startToolHookStatusTimer).toHaveBeenCalledTimes(1);

		await prototype.handleEvent.call(fakeThis, {
			type: "tool_hook_status",
			phase: "end",
			hookRunId: "run-1",
			hookName: "PostToolUse",
			toolName: "bash",
			toolCallId: "call-1",
			extensionPath: "<builtin:permission-system>",
			statusMessage: "matching project rules",
			startedAt: now - 7_000,
			completedAt: now,
			status: "completed",
		});

		expect(hookStatusContainer.children).toHaveLength(0);
		expect(fakeThis.stopToolHookStatusTimer).toHaveBeenCalledTimes(1);
	});
});
