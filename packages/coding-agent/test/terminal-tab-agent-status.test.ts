import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { APP_TITLE } from "../src/config.ts";
import { formatAgentActivityTitle } from "../src/modes/interactive/agent-activity-status.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const NORMAL_TITLE = `${APP_TITLE} - Visible Session - senpi-project`;

type HandleEventThis = Record<string, unknown> & {
	agentActivityStatus: "working" | "idle";
	titles: string[];
};

/**
 * Build a `this` for `InteractiveMode.prototype.handleEvent` that carries the real
 * activity-status members plus no-op stand-ins for the collaborators the handled
 * events touch. Everything status-related is the real prototype implementation, so
 * removing the agent_start/agent_end wiring makes these tests fail.
 */
function createEventSeamThis(): HandleEventThis {
	const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const titles: string[] = [];

	const fakeThis: HandleEventThis = {
		titles,
		agentActivityStatus: "idle",

		// real implementations under test
		applyTerminalTitle: prototype.applyTerminalTitle,
		setAgentActivityStatus: prototype.setAgentActivityStatus,
		getNormalTerminalTitle: prototype.getNormalTerminalTitle,
		updateTerminalTitle: prototype.updateTerminalTitle,

		// title composition inputs
		activeToolTerminalTitle: undefined,
		activeToolExecutionTerminalTitle: undefined,
		extensionTerminalTitle: undefined,
		sessionManager: {
			getCwd: () => "/tmp/senpi-project",
			getSessionName: () => "Visible Session",
		},
		ui: {
			requestRender: vi.fn(),
			terminal: {
				setTitle: (title: string) => titles.push(title),
				setProgress: vi.fn(),
			},
		},

		// collaborators touched by the handled events
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		session: { isStreaming: false, abortCompaction: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		statusContainer: { clear: vi.fn(), addChild: vi.fn() },
		chatContainer: { clear: vi.fn() },
		defaultEditor: {} as { onEscape?: () => void },
		autoCompactionEscapeHandler: undefined,
		autoCompactionLoader: undefined,
		autoCompactionProgressText: "",
		workingVisible: false,
		retryEscapeHandler: undefined,
		retryCountdown: undefined,
		retryLoader: undefined,
		streamingComponent: undefined,
		pendingTools: new Map(),
		activeToolExecutions: new Map(),
		activeToolHooks: new Map(),
		hookStatusContainer: { clear: vi.fn(), addChild: vi.fn() },
		clearPendingTools: vi.fn(),
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		stopToolHookStatusTimer: vi.fn(),
		stopWorkingLoader: vi.fn(),
		startWorkingElapsedTimer: vi.fn(),
		checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		rebuildChatFromMessages: vi.fn(),
		addMessageToChat: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
	};
	return fakeThis;
}

async function dispatch(fakeThis: HandleEventThis, event: Record<string, unknown>): Promise<void> {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: HandleEventThis,
		e: Record<string, unknown>,
	) => Promise<void>;
	await handleEvent.call(fakeThis, event);
}

describe("terminal tab agent status", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	// process.title is global state; guard against any test leaking a mutation.
	const originalProcessTitle = process.title;
	afterEach(() => {
		process.title = originalProcessTitle;
	});

	test("agent_start marks the title working and agent_end restores the idle title", async () => {
		// Given
		const fakeThis = createEventSeamThis();

		// When
		await dispatch(fakeThis, { type: "agent_start" });

		// Then
		expect(fakeThis.agentActivityStatus).toBe("working");
		expect(fakeThis.titles.at(-1)).toBe(`[working] ${NORMAL_TITLE}`);

		// When
		await dispatch(fakeThis, { type: "agent_end" });

		// Then
		expect(fakeThis.agentActivityStatus).toBe("idle");
		expect(fakeThis.titles.at(-1)).toBe(NORMAL_TITLE);
	});

	test("compaction_start marks working and compaction_end restores idle", async () => {
		// Given
		const fakeThis = createEventSeamThis();

		// When
		await dispatch(fakeThis, { type: "compaction_start", reason: "extension" });

		// Then
		expect(fakeThis.agentActivityStatus).toBe("working");
		expect(fakeThis.titles.at(-1)).toBe(`[working] ${NORMAL_TITLE}`);

		// When
		await dispatch(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: { tokensBefore: 1, summary: "s" },
			aborted: false,
			willRetry: false,
		});

		// Then
		expect(fakeThis.agentActivityStatus).toBe("idle");
		expect(fakeThis.titles.at(-1)).toBe(NORMAL_TITLE);
	});

	test("compaction_end keeps the working status while the agent is still streaming", async () => {
		// Given a compaction that happens mid-turn
		const fakeThis = createEventSeamThis();
		await dispatch(fakeThis, { type: "agent_start" });
		(fakeThis.session as { isStreaming: boolean }).isStreaming = true;
		await dispatch(fakeThis, { type: "compaction_start", reason: "threshold" });

		// When
		await dispatch(fakeThis, {
			type: "compaction_end",
			reason: "threshold",
			result: { tokensBefore: 1, summary: "s" },
			aborted: false,
			willRetry: false,
		});

		// Then the turn is still running, so the title must stay working
		expect(fakeThis.agentActivityStatus).toBe("working");
		expect(fakeThis.titles.at(-1)).toBe(`[working] ${NORMAL_TITLE}`);
	});

	test("stop() clears the working status so the title does not stay stuck", async () => {
		// Given
		const fakeThis = createEventSeamThis();
		await dispatch(fakeThis, { type: "agent_start" });
		expect(fakeThis.agentActivityStatus).toBe("working");

		Object.assign(fakeThis, {
			isInitialized: false,
			clearExtensionTerminalInputListeners: vi.fn(),
			footer: { invalidate: vi.fn(), dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			unsubscribe: undefined,
			unregisterSignalHandlers: vi.fn(),
		});

		// When
		const stop = Reflect.get(InteractiveMode.prototype, "stop") as (this: HandleEventThis) => void;
		stop.call(fakeThis);

		// Then
		expect(fakeThis.agentActivityStatus).toBe("idle");
		expect(fakeThis.titles.at(-1)).toBe(NORMAL_TITLE);
	});

	test("status token stays in front of active tool titles so it survives tab truncation", async () => {
		// Given
		const fakeThis = createEventSeamThis();
		fakeThis.activeToolExecutionTerminalTitle = `${APP_TITLE} - Running bash: npm run check`;

		// When
		await dispatch(fakeThis, { type: "agent_start" });

		// Then
		const title = String(fakeThis.titles.at(-1));
		expect(title.startsWith("[working] ")).toBe(true);
		expect(title).toContain("Running bash: npm run check");
	});

	test("repeated identical status events do not rewrite the title", async () => {
		// Given
		const fakeThis = createEventSeamThis();

		// When
		await dispatch(fakeThis, { type: "agent_start" });
		await dispatch(fakeThis, { type: "agent_start" });

		// Then
		expect(fakeThis.titles.filter((t) => t.startsWith("[working]"))).toHaveLength(1);
	});

	test("an unset activity status renders the plain title, never a stray token", () => {
		// Given a caller that never initialized the status field
		const fakeThis = createEventSeamThis();
		(fakeThis as { agentActivityStatus?: "working" | "idle" }).agentActivityStatus = undefined;

		// When
		const applyTerminalTitle = Reflect.get(InteractiveMode.prototype, "applyTerminalTitle") as (
			this: HandleEventThis,
		) => void;
		applyTerminalTitle.call(fakeThis);

		// Then
		expect(fakeThis.titles.at(-1)).toBe(NORMAL_TITLE);
	});

	test("formats the working token, and leaves idle titles untouched", () => {
		expect(formatAgentActivityTitle("working", "senpi - project")).toBe("[working] senpi - project");
		expect(formatAgentActivityTitle("working", "")).toBe("[working]");
		expect(formatAgentActivityTitle("idle", "senpi - project")).toBe("senpi - project");
		expect(formatAgentActivityTitle("idle", "")).toBe("");
	});

	test("does not mutate process.title", async () => {
		// Given
		const before = process.title;
		const fakeThis = createEventSeamThis();

		// When
		await dispatch(fakeThis, { type: "agent_start" });
		await dispatch(fakeThis, { type: "agent_end" });

		// Then
		expect(process.title).toBe(before);
	});
});
