import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows a context compaction loader for extension compaction starts", async () => {
		const statusContainer = new Container();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined as { stop(): void } | undefined,
			defaultEditor: {} as { onEscape?: () => void },
			session: { abortCompaction: vi.fn() },
			statusContainer,
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_start";
				reason: "extension";
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_start",
			reason: "extension",
		});

		const rendered = stripAnsi(statusContainer.children.flatMap((child) => child.render(120)).join("\n"));
		expect(rendered).toContain("Compacting context");
		expect(rendered).toContain("to cancel");

		fakeThis.autoCompactionLoader?.stop();
	});

	test("renders streamed compaction progress below the active loader", async () => {
		const statusContainer = new Container();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined as { stop(): void } | undefined,
			autoCompactionProgressText: "",
			defaultEditor: {} as { onEscape?: () => void },
			session: { abortCompaction: vi.fn() },
			statusContainer,
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event:
				| {
						type: "compaction_start";
						reason: "extension";
				  }
				| {
						type: "compaction_progress";
						reason: "extension";
						delta: string;
				  },
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_start",
			reason: "extension",
		});
		await handleEvent.call(fakeThis, {
			type: "compaction_progress",
			reason: "extension",
			delta: "live summary chunk",
		});

		const rendered = stripAnsi(statusContainer.children.flatMap((child) => child.render(120)).join("\n"));
		expect(rendered).toContain("Compacting context");
		expect(rendered).toContain("live summary chunk");

		fakeThis.autoCompactionLoader?.stop();
	});

	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("surfaces a manual would-overflow rejection instead of silently swallowing it", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn(), addChild: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual";
				result: undefined;
				aborted: false;
				willRetry: false;
				accepted: false;
				rejectionCause: "would-overflow";
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			accepted: false,
			rejectionCause: "would-overflow",
		});

		// The user typed /compact and the compaction was rejected because the summary
		// would still overflow the context window. Silent failure is the bug: the user
		// must see feedback that names the rejection cause.
		const feedback = [
			...fakeThis.showError.mock.calls.map((call) => String(call[0])),
			...fakeThis.showWarning.mock.calls.map((call) => String(call[0])),
			...fakeThis.showStatus.mock.calls.map((call) => String(call[0])),
		].join("\n");
		expect(feedback).toMatch(/would.?overflow|overflow|rejected/i);
		// Rejected compaction retains editor-owned input instead of submitting it
		// through a recursive post-compaction prompt path.
		expect(fakeThis.flushCompactionQueue).not.toHaveBeenCalled();
	});

	test("sanitizes a detached continuation launch failure before rendering", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			showError: vi.fn(),
		};
		const hostileMessage =
			"Failed\u001b]52;c;c2VjcmV0\u0007 to\u001b]0;stolen title\u0007 continue" +
			"\u001b]8;;https://attacker.invalid\u0007 queued\u001b]8;;\u0007\u0000 messages:\u007f" +
			"\u0085 \u009b31mprovider\u009b0m unavailable";
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "continuation_error"; errorMessage: string },
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "continuation_error",
			errorMessage: hostileMessage,
		});

		expect(fakeThis.showError).toHaveBeenCalledWith("Failed to continue queued messages: provider unavailable");
		const rendered = fakeThis.showError.mock.calls[0]?.[0];
		expect(rendered).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(rendered).not.toContain("]52;");
		expect(rendered).not.toContain("attacker.invalid");
		expect(rendered).not.toContain("stolen title");
	});

	test("renders OpenAI remote compaction details in the summary card", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "OpenAI remote compaction checkpoint.",
			tokensBefore: 1234,
			timestamp: Date.now(),
			details: {
				schema: "senpi.compaction.openai-remote.v1",
				mode: "openai-remote",
				provider: "openai",
				api: "openai-responses",
				transport: "websocket",
				modelId: "gpt-5.4",
				retainedInputItemCount: 2,
				requestInputItemCount: 5,
			},
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("OpenAI Responses WebSocket compaction");
		expect(rendered).toContain("2 retained items");
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const message = { text: "change direction", mode: "steer" as const };
		const fakeThis = {
			compactionQueuedMessages: [message],
			compactionInFlightMessages: [] as (typeof message)[],
			compactionTransferAbortControllers: new Map<typeof message, AbortController>(),
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockImplementation(
					(
						_text: string,
						options?: {
							preflightResult?: (success: boolean) => void;
							promptDisposition?: (disposition: "handled" | "queued" | "started") => void;
						},
					) => {
						options?.promptDisposition?.("started");
						options?.preflightResult?.(true);
						return Promise.resolve();
					},
				),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith(
			"change direction",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("restores the normal escape handler after a superseded compaction sequence", async () => {
		const statusContainer = new Container();
		const abortCompaction = vi.fn();
		const abortAndFireQueuedMessages = vi.fn().mockResolvedValue(undefined);
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionProgressText: "",
			retryEscapeHandler: undefined as (() => void) | undefined,
			activeStatusIndicator: undefined as { dispose(): void } | undefined,
			defaultEditor: {
				onEscape: undefined as (() => void) | undefined,
				onAction: vi.fn(),
				onCtrlD: undefined as unknown,
				onChange: undefined as unknown,
				onPasteImage: undefined as unknown,
			},
			editor: { getText: () => "", setText: vi.fn() },
			session: {
				isStreaming: true,
				retryAttempt: 0,
				isBashRunning: false,
				abortBash: vi.fn(),
				abortCompaction,
			},
			abortAndFireQueuedMessages,
			isBashMode: false,
			lastEscapeTime: 0,
			statusContainer,
			chatContainer: { clear: vi.fn(), addChild: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false, getDoubleEscapeAction: () => "none" },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() }, onDebug: undefined as unknown },
		};

		// Install the real normal Escape handler, then drive the real event handler
		// through a supersession sequence: compaction A starts, compaction B starts
		// before A ends (A is superseded and never emits compaction_end), then B ends.
		const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (
			this: typeof fakeThis,
		) => void;
		setupKeyHandlers.call(fakeThis);
		const normalEscapeHandler = fakeThis.defaultEditor.onEscape;
		expect(typeof normalEscapeHandler).toBe("function");

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event:
				| { type: "compaction_start"; reason: "extension" }
				| {
						type: "compaction_end";
						reason: "extension";
						result: { tokensBefore: number; summary: string } | undefined;
						aborted: boolean;
						willRetry: boolean;
						accepted: boolean;
				  },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "extension" });
		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "extension" });
		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "extension",
			result: { tokensBefore: 42, summary: "summary" },
			aborted: false,
			willRetry: false,
			accepted: true,
		});

		// The compaction escape override must be fully unwound back to the handler
		// that was installed before compaction A started, not to compaction A's stale
		// abort closure captured when compaction B superseded it.
		expect(fakeThis.autoCompactionEscapeHandler).toBeUndefined();
		expect(fakeThis.defaultEditor.onEscape).toBe(normalEscapeHandler);

		// Escape during streaming/retry must run the normal cancellation path.
		fakeThis.defaultEditor.onEscape?.();
		expect(abortAndFireQueuedMessages).toHaveBeenCalledTimes(1);
		expect(abortCompaction).not.toHaveBeenCalled();

		fakeThis.activeStatusIndicator?.dispose();
	});
});
