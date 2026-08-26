import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import { Container, isViewportTUI, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { FullscreenExitOutput, TuiMode } from "../src/core/settings-manager.ts";
import { IdleStatus } from "../src/modes/interactive/components/status-indicator.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		const mainTerminal = new RecordingTerminal();
		const mainTui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: mainTerminal,
		});
		expect(mainTui.mode).toBe("regular");
		expect(isViewportTUI(mainTui)).toBe(false);
		mainTui.start();
		await mainTerminal.waitForRender();
		expect(mainTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		mainTui.stop();

		const altTerminal = new RecordingTerminal();
		const altTui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: altTerminal,
		});
		expect(altTui.mode).toBe("fullscreen");
		expect(isViewportTUI(altTui)).toBe(true);
		altTui.start();
		await altTerminal.waitForRender();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		altTui.stop();
	});

	it("replaces the renderer and restores the previous screen for resume-hint exits", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const invalidatedModes: TuiMode[] = [];
		const component: Component & { focused: boolean } = {
			focused: false,
			render: () => ["content"],
			invalidate: () => invalidatedModes.push(stableUi.mode),
		};
		renderer.addChild(component);
		renderer.setFocus(component);

		type SwitchContext = {
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			fullscreenLayoutRoot: Component;
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			fullscreenLayoutRoot: component,
			options: { tuiMode: "regular" as TuiMode },
			themeController: { rebindTui: () => {} },
			extensionTerminalInputSubscriptions: new Set<never>(),
		}) as SwitchContext;
		const stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const { stopInteractiveTui, switchTuiMode } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: SwitchContext, fullscreenExitOutput: FullscreenExitOutput): void;
			switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		renderer.start();
		await terminal.waitForRender();
		expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
		await terminal.waitForRender();

		expect(stableUi.mode).toBe("fullscreen");
		expect(context.renderer.children).toEqual([component]);
		expect(context.renderer.getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(invalidatedModes).toEqual(["fullscreen"]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);

		stopInteractiveTui.call(context, "resume-hint");

		expect(stableUi.mode).toBe("fullscreen");
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 2]);
	});
});

describe("switchTuiMode component lifecycle", () => {
	it("remounts live components without disposing them", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const dispose = vi.fn();
		const component: Component & { focused: boolean } = {
			focused: false,
			render: () => ["content"],
			invalidate: () => {},
			dispose,
		};
		renderer.addChild(component);
		renderer.setFocus(component);

		type SwitchContext = {
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			fullscreenLayoutRoot: Component;
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			fullscreenLayoutRoot: component,
			options: { tuiMode: "regular" as TuiMode },
			themeController: { rebindTui: () => {} },
			extensionTerminalInputSubscriptions: new Set<never>(),
		}) as SwitchContext;
		const stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const { switchTuiMode } = InteractiveMode.prototype as unknown as {
			switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		renderer.start();
		await terminal.waitForRender();
		expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
		await terminal.waitForRender();

		// Components moved to the new renderer must stay alive: disposing them on
		// switch kills their intervals (spinners, reveals) while they keep
		// rendering static frames forever.
		expect(dispose).not.toHaveBeenCalled();
		expect(context.renderer.children).toEqual([component]);
	});
});

describe("handleReloadCommand extension UI lifecycle", () => {
	function makeContext(session: unknown) {
		const resetExtensionUI = vi.fn();
		const editor = new Container();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const ui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new VirtualTerminal(80, 24),
		});
		ui.start();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session },
			editor,
			editorContainer,
			ui,
			resetExtensionUI,
			rebuildChatFromMessages: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			hideThinkingBlock: false,
			outputPad: 0,
		}) as unknown as InteractiveMode;
		return { context, resetExtensionUI, ui };
	}
	const proto = InteractiveMode.prototype as unknown as {
		handleReloadCommand(this: InteractiveMode): Promise<void>;
	};

	it("leaves extension UI untouched when the reload is vetoed", async () => {
		// resetExtensionUI() disposes every extension footer/header/widget. Running
		// it before reload() re-checks the extension veto destroys live extension UI
		// (goal tickers, task widgets, hook statuses) with nothing left to restore
		// it: the TUI stops self-repainting until an input event forces a frame.
		initTheme("dark");
		const session = {
			isCompacting: false,
			settingsManager: { getHideThinkingBlock: () => false, getOutputPad: () => 0 },
			checkReloadVeto: async () => ({ cancelled: false }),
			reload: async () => ({ cancelled: true, reason: "subagents running" }),
		};
		const { context, resetExtensionUI, ui } = makeContext(session);

		await proto.handleReloadCommand.call(context);

		expect(resetExtensionUI).not.toHaveBeenCalled();
		ui.stop();
	});

	it("resets extension UI exactly when a proceeding reload rebuilds the session", async () => {
		initTheme("dark");
		const sentinel = new Error("boom after commit point");
		const session = {
			isCompacting: false,
			settingsManager: { getHideThinkingBlock: () => false, getOutputPad: () => 0 },
			checkReloadVeto: async () => ({ cancelled: false }),
			reload: async (options?: { beforeSessionStart?: () => void | Promise<void> }) => {
				await options?.beforeSessionStart?.();
				throw sentinel;
			},
		};
		const { context, resetExtensionUI, ui } = makeContext(session);

		await proto.handleReloadCommand.call(context);

		expect(resetExtensionUI).toHaveBeenCalledOnce();
		ui.stop();
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: ReturnType<typeof createInteractiveTui>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type CopyCommandOptions = { flashConfirmation?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("flashes Copied! for the copy shortcut in fullscreen mode", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		ui.start();
		try {
			await terminal.waitForRender();
			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("keeps the status-line confirmation for the copy shortcut in regular mode", async () => {
		const ui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });

		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	options: { tuiMode?: TuiMode };
	ui: { getClearOnShrink: () => boolean; terminal: { columns: number; rows: number } };
	idleStatus: IdleStatus;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves the measured status height only on the main-screen renderer", () => {
		for (const tuiMode of ["regular", "fullscreen"] as const) {
			const dispose = vi.fn();
			const statusContainer = new Container();
			for (const line of ["one", "two", "three", "four"]) {
				statusContainer.addChild(new Text(line, 0, 0));
			}
			const outgoingHeight = statusContainer.render(80).length;
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer,
				options: { tuiMode },
				ui: { getClearOnShrink: () => true, terminal: { columns: 80, rows: 24 } },
				idleStatus: new IdleStatus(),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.render(80).length).toBe(tuiMode === "regular" ? outgoingHeight : 0);
		}
	});
});

type RetryStatusEvent = {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
};

type RetryStatusContext = {
	ui: TUI;
	statusContainer: Container;
	activeStatusIndicator: (Component & { dispose(): void }) | undefined;
	runtimeHost: {
		session: {
			sessionManager: { getEntries(): readonly unknown[] };
		};
	};
};

type RetryInteractiveModePrototype = {
	showRetryStatusIndicator(this: RetryStatusContext, event: RetryStatusEvent & { type: "auto_retry_start" }): void;
	showSummarizationRetryStatusIndicator(
		this: RetryStatusContext,
		event: RetryStatusEvent & { type: "summarization_retry_scheduled" },
	): void;
};

const retryInteractiveModePrototype = InteractiveMode.prototype as unknown as RetryInteractiveModePrototype;

function createRetryStatusContext(sessionEntryCount: number): RetryStatusContext {
	const ui = createInteractiveTui({
		tuiMode: "regular",
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal: new RecordingTerminal(80, 24),
	});
	return Object.assign(Object.create(InteractiveMode.prototype), {
		ui,
		statusContainer: new Container(),
		activeStatusIndicator: undefined,
		runtimeHost: {
			session: {
				sessionManager: {
					getEntries: () => Array.from({ length: sessionEntryCount }, () => ({})),
				},
			},
		},
	}) as RetryStatusContext;
}

function renderRetryStatus(context: RetryStatusContext): string {
	const component = context.statusContainer.children[0];
	if (!component) throw new Error("retry status indicator was not mounted");
	return component.render(80).join("\n");
}

describe("retry indicator cadence", () => {
	it("throttles retry indicator animation for large sessions", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const context = createRetryStatusContext(1_000);

		try {
			retryInteractiveModePrototype.showRetryStatusIndicator.call(context, {
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 5_000,
			});
			const initialFrame = renderRetryStatus(context);

			vi.advanceTimersByTime(999);
			expect(renderRetryStatus(context)).toBe(initialFrame);

			vi.advanceTimersByTime(1);
			expect(renderRetryStatus(context)).not.toBe(initialFrame);
		} finally {
			context.activeStatusIndicator?.dispose();
			context.ui.stop();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("keeps retry indicator animation for small sessions", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const context = createRetryStatusContext(999);

		try {
			retryInteractiveModePrototype.showRetryStatusIndicator.call(context, {
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 5_000,
			});
			const initialFrame = renderRetryStatus(context);

			vi.advanceTimersByTime(80);
			expect(renderRetryStatus(context)).not.toBe(initialFrame);
		} finally {
			context.activeStatusIndicator?.dispose();
			context.ui.stop();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("throttles summarization retry animation for large sessions", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const context = createRetryStatusContext(1_000);

		try {
			retryInteractiveModePrototype.showSummarizationRetryStatusIndicator.call(context, {
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 5_000,
			});
			const initialFrame = renderRetryStatus(context);

			vi.advanceTimersByTime(999);
			expect(renderRetryStatus(context)).toBe(initialFrame);

			vi.advanceTimersByTime(1);
			expect(renderRetryStatus(context)).not.toBe(initialFrame);
		} finally {
			context.activeStatusIndicator?.dispose();
			context.ui.stop();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});
