import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { IdleStatus } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Fixture = {
	activeStatusIndicator: { kind: "working" | "retry"; dispose: () => void } | undefined;
	statusContainer: Container;
	pendingUserInputs: unknown[];
	workingVisible: boolean;
	workingMessage: string | undefined;
	defaultWorkingMessage: string;
	isInitialized: boolean;
	options: { tuiMode: "regular" };
	idleStatus: IdleStatus;
	turnWorkingTip: { resetForNewTurn: () => void };
	chrome: { createWorkingIndicator: () => { kind: "working"; dispose: () => void } };
	footer: { invalidate: () => void };
	settingsManager: { getShowTerminalProgress: () => boolean };
	ui: {
		requestRender: () => void;
		terminal: { setProgress: (value: boolean) => void; columns: number; rows: number };
	};
	checkShutdownRequested: () => Promise<void>;
	clearPendingTools: () => void;
	clearActiveToolExecutionStatus: () => void;
	clearToolHookStatuses: () => void;
	streamingReveal: { stop: () => void };
	toolResultReveal: { stop: () => void };
	detachAssistantTextSegments: () => void;
	streamingComponent: undefined;
	getWorkingIndicatorOptions: () => Record<string, never>;
	showStatusIndicator: (indicator: { kind: "working" }) => void;
	clearStatusIndicator: (kind?: "working" | "retry") => void;
};

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: (event: any) => Promise<void> })
	.handleEvent;
const clearStatusIndicator = (
	InteractiveMode.prototype as unknown as {
		clearStatusIndicator: (kind?: "working" | "retry") => void;
	}
).clearStatusIndicator;

function fixture(): Fixture {
	return {
		activeStatusIndicator: { kind: "working", dispose: vi.fn() },
		statusContainer: new Container(),
		pendingUserInputs: [],
		workingVisible: true,
		workingMessage: undefined,
		defaultWorkingMessage: "Working",
		isInitialized: true,
		options: { tuiMode: "regular" },
		idleStatus: new IdleStatus(),
		turnWorkingTip: { resetForNewTurn: vi.fn() },
		chrome: { createWorkingIndicator: () => ({ kind: "working", dispose: vi.fn() }) },
		footer: { invalidate: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		ui: {
			requestRender: vi.fn(),
			getClearOnShrink: () => false,
			terminal: { setProgress: vi.fn(), columns: 80, rows: 24 },
		} as Fixture["ui"] & { getClearOnShrink: () => boolean },
		checkShutdownRequested: vi.fn(async () => {}),
		clearPendingTools: vi.fn(),
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		streamingReveal: { stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		detachAssistantTextSegments: vi.fn(),
		streamingComponent: undefined,
		getWorkingIndicatorOptions: () => ({}),
		showStatusIndicator: vi.fn((indicator) => {
			fixtureStatus.activeStatusIndicator = indicator;
			fixtureStatus.statusContainer.clear();
			fixtureStatus.statusContainer.addChild(new Text("working", 0, 0));
		}),
		clearStatusIndicator: clearStatusIndicator,
	};
}

let fixtureStatus: Fixture;

describe("TUI vertical jitter lifecycle", () => {
	it("keeps the working dock painted between agent_end and the next agent_start", async () => {
		fixtureStatus = fixture();
		fixtureStatus.statusContainer.addChild(new Text("working", 0, 0));
		const before = fixtureStatus.statusContainer.render(80).length;

		await handleEvent.call(fixtureStatus, { type: "agent_end" });
		const between = fixtureStatus.statusContainer.render(80).length;
		await handleEvent.call(fixtureStatus, { type: "agent_start" });
		const after = fixtureStatus.statusContainer.render(80).length;

		expect(between).toBeGreaterThan(0);
		expect(after).toBe(before);
	});

	it("clears working only when idle without buffered input", async () => {
		fixtureStatus = fixture();
		fixtureStatus.statusContainer.addChild(new Text("working", 0, 0));
		fixtureStatus.pendingUserInputs.push({ text: "queued" });

		await handleEvent.call(fixtureStatus, { type: "agent_end" });
		await handleEvent.call(fixtureStatus, { type: "agent_idle" });
		expect(fixtureStatus.statusContainer.render(80).length).toBeGreaterThan(0);

		fixtureStatus.pendingUserInputs.length = 0;
		await handleEvent.call(fixtureStatus, { type: "agent_idle" });
		expect(fixtureStatus.statusContainer.render(80).length).toBe(0);
	});

	it("does not let a delayed working clear remove a newer indicator", () => {
		fixtureStatus = fixture();
		const retry = { kind: "retry" as const, dispose: vi.fn() };
		fixtureStatus.activeStatusIndicator = retry;
		fixtureStatus.statusContainer.addChild(new Text("retry", 0, 0));

		clearStatusIndicator.call(fixtureStatus, "working");

		expect(fixtureStatus.activeStatusIndicator).toBe(retry);
		expect(fixtureStatus.statusContainer.render(80).length).toBeGreaterThan(0);
	});

	it("reserves the measured outgoing height for clear-on-shrink", () => {
		fixtureStatus = fixture();
		fixtureStatus.statusContainer.addChild(new Text("one", 0, 0));
		fixtureStatus.statusContainer.addChild(new Text("two", 0, 0));
		fixtureStatus.statusContainer.addChild(new Text("three", 0, 0));
		fixtureStatus.statusContainer.addChild(new Text("four", 0, 0));
		const outgoingHeight = fixtureStatus.statusContainer.render(80).length;
		(fixtureStatus.ui as Fixture["ui"] & { getClearOnShrink: () => boolean }).getClearOnShrink = () => true;

		clearStatusIndicator.call(fixtureStatus);

		expect(fixtureStatus.statusContainer.render(80).length).toBe(outgoingHeight);
	});
});
