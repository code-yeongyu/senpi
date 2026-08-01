import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, sanitizeTerminalLabel, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeCompactionFakeThis<T extends object>(overrides: T) {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		autoCompactionEscapeHandler: undefined as (() => void) | undefined,
		autoCompactionLoader: undefined as { stop(): void } | undefined,
		autoCompactionProgressText: "",
		defaultEditor: {} as { onEscape?: () => void },
		session: { abortCompaction: vi.fn() },
		statusContainer: { clear: vi.fn() },
		chatContainer: { clear: vi.fn(), addChild: vi.fn() },
		rebuildChatFromMessages: vi.fn(),
		addMessageToChat: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		clearStatusIndicator: vi.fn(),
		compactionQueuedMessages: [] as Array<{ text: string; mode: "steer" | "followUp" }>,
		getSessionLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
		flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
		restoreQueuedMessagesToEditor: vi.fn(),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		...overrides,
	};
}

type PrivateMethod = (this: object, ...args: unknown[]) => void;

function renderExpandedPersistedCompactionSummary(sessionManager: SessionManager): string {
	const chatContainer = new Container();
	const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as PrivateMethod;
	const renderSessionItems = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as PrivateMethod;
	const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as PrivateMethod;
	const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as PrivateMethod;
	if (
		typeof addMessageToChat !== "function" ||
		typeof renderSessionItems !== "function" ||
		typeof renderSessionEntries !== "function" ||
		typeof rebuildChatFromMessages !== "function"
	) {
		throw new Error("Expected InteractiveMode chat rebuilding methods");
	}

	const fakeThis = {
		chatContainer,
		sessionManager,
		toolOutputExpanded: true,
		clearPendingTools: () => {},
		pendingTools: new Map(),
		settingsManager: {
			getCodeBlockIndent: () => 0,
			getShowCacheMissNotices: () => false,
		},
		ui: { requestRender: () => {} },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		addMessageToChat: (..._args: unknown[]) => {},
		renderSessionItems: (..._args: unknown[]) => {},
		renderSessionEntries: (..._args: unknown[]) => {},
	};
	fakeThis.addMessageToChat = (...args) => addMessageToChat.call(fakeThis, ...args);
	fakeThis.renderSessionItems = (...args) => renderSessionItems.call(fakeThis, ...args);
	fakeThis.renderSessionEntries = (...args) => renderSessionEntries.call(fakeThis, ...args);

	rebuildChatFromMessages.call(fakeThis);
	const component = chatContainer.children.find(
		(child): child is CompactionSummaryMessageComponent => child instanceof CompactionSummaryMessageComponent,
	);
	if (!component) throw new Error("Expected rebuilt chat to contain a compaction summary");
	component.setExpanded(true);
	return stripAnsi(component.render(120).join("\n"));
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows a context compaction loader for extension compaction starts", async () => {
		const statusContainer = new Container();
		const fakeThis = makeCompactionFakeThis({ statusContainer });

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

	test("bounds streamed compaction progress to the active status row", async () => {
		const statusContainer = new Container();
		const fakeThis = makeCompactionFakeThis({ statusContainer });

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

		// Before any progress arrives the indicator must already be a single row so the
		// composer does not shift when the preview appears.
		const preProgressLines = statusContainer.children.flatMap((child) => child.render(40));
		expect(preProgressLines).toHaveLength(1);

		await handleEvent.call(fakeThis, {
			type: "compaction_progress",
			reason: "extension",
			delta: `live\n${"summary chunk ".repeat(40)}`,
		});

		const renderedLines = statusContainer.children.flatMap((child) => child.render(40));
		const rendered = stripAnsi(renderedLines.join("\n"));
		expect(renderedLines).toHaveLength(1);
		expect(visibleWidth(renderedLines[0] ?? "")).toBeLessThanOrEqual(40);
		expect(rendered).toContain("Compacting");
		// The cancellation hint keeps priority over the streamed preview.
		expect(rendered).toContain("to cancel");
		// The preview shows the newest trailing columns, not the frozen opening words.
		expect(rendered).toContain("chunk");
		expect(rendered).not.toContain("live");

		fakeThis.autoCompactionLoader?.stop();
	});

	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = makeCompactionFakeThis({ chatContainer: { clear: vi.fn() } });

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
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false, deferAdmission: false });
		expect(fakeThis.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
	});

	test.each([
		["truncated generator", "Pre-prompt compaction failed: Compaction stream ended without a complete result"],
		["timeout", "Pre-prompt compaction failed: Compaction timed out after 120000ms"],
	])(
		"compaction queue recovery restores queued messages after terminal compaction failure: %s",
		async (_name, errorMessage) => {
			const fakeThis = makeCompactionFakeThis({
				compactionQueuedMessages: [{ text: "queued during compaction", mode: "steer" as const }],
				restoreQueuedMessagesToEditor: vi.fn().mockReturnValue(1),
			});

			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof fakeThis,
				event: {
					type: "compaction_end";
					reason: "threshold";
					result: undefined;
					aborted: false;
					willRetry: false;
					errorMessage: string;
				},
			) => Promise<void>;

			await handleEvent.call(fakeThis, {
				type: "compaction_end",
				reason: "threshold",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage,
			});

			expect(fakeThis.restoreQueuedMessagesToEditor).toHaveBeenCalledTimes(1);
			expect(fakeThis.flushCompactionQueue).not.toHaveBeenCalled();
			// The status must describe restoration, not promise a next-turn send.
			const statuses = fakeThis.showStatus.mock.calls.map((call) => String(call[0]));
			expect(statuses.some((message) => /restored to the editor/i.test(message))).toBe(true);
			expect(statuses.some((message) => /will send with the next turn/i.test(message))).toBe(false);
		},
	);

	test("compaction queue recovery defers retryable failures to the native queues", async () => {
		const fakeThis = makeCompactionFakeThis({
			compactionQueuedMessages: [{ text: "queued during compaction", mode: "steer" as const }],
			restoreQueuedMessagesToEditor: vi.fn().mockReturnValue(0),
		});

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "overflow";
				result: undefined;
				aborted: false;
				willRetry: true;
				errorMessage: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: true,
			errorMessage: "Pre-prompt compaction failed: transient provider error",
		});

		// A retryable failure keeps the upstream native-queue handoff so the queued
		// input rides along with the retry instead of returning to the editor.
		expect(fakeThis.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true, deferAdmission: true });
		expect(fakeThis.showStatus.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/queued message/i);
	});

	test("compaction queue recovery restores a manual would-overflow rejection instead of silently swallowing it", async () => {
		const fakeThis = makeCompactionFakeThis({});

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
		// A terminal rejection restores editor-owned input instead of submitting it
		// through a recursive post-compaction prompt path or a native queue handoff.
		expect(fakeThis.flushCompactionQueue).not.toHaveBeenCalled();
		expect(fakeThis.restoreQueuedMessagesToEditor).toHaveBeenCalledTimes(1);
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

	test("sanitizes compaction progress, errors, and display summaries without rewriting the event result", async () => {
		const hostileText =
			"compaction\u001b]52;c;c2VjcmV0\u0007 live\u001b]0;stolen title\u0007 " +
			"\u001b]8;;https://attacker.invalid\u0007link\u001b]8;;\u0007 \u001b[31mcolor\u001b[0m \u009b31mprovider\u009b0m";
		const sanitizedText = sanitizeTerminalLabel(hostileText);
		const statusContainer = new Container();
		const chatContainer = new Container();
		const fakeThis = makeCompactionFakeThis({ statusContainer, chatContainer });
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: object,
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "extension" });
		await handleEvent.call(fakeThis, { type: "compaction_progress", reason: "extension", delta: hostileText });
		const renderedProgress = stripAnsi(statusContainer.children.flatMap((child) => child.render(120)).join("\n"));
		expect(renderedProgress).toContain(sanitizedText);
		expect(renderedProgress).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(renderedProgress).not.toContain("attacker.invalid");
		expect(renderedProgress).not.toContain("stolen title");

		const result = { tokensBefore: 123, summary: hostileText };
		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "extension",
			result,
			aborted: false,
			willRetry: false,
			accepted: true,
		});
		expect(result.summary).toBe(hostileText);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(expect.objectContaining({ summary: sanitizedText }));

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "extension" });
		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "extension",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: hostileText,
		});
		const renderedError = stripAnsi(chatContainer.children.flatMap((child) => child.render(120)).join("\n"));
		expect(renderedError).toContain(sanitizedText);
		expect(renderedError).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(renderedError).not.toContain("attacker.invalid");
		expect(renderedError).not.toContain("stolen title");
		expect(fakeThis.restoreQueuedMessagesToEditor).toHaveBeenCalledTimes(1);
	});

	test("renders persisted hostile summaries safely after a chat rebuild and session reopen", () => {
		const hostileSummary =
			"persisted\u001b]52;c;c2VjcmV0\u0007 summary\u001b]0;stolen title\u0007 " +
			"\u001b]8;;https://attacker.invalid\u0007link\u001b]8;;\u0007 \u001b[31mcolor\u001b[0m \u0000\u0001\u007f\u0085\u009b31mprovider\u009b0m";
		const tempDir = mkdtempSync(join(tmpdir(), "pi-hostile-compaction-summary-"));

		try {
			const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "context that was compacted" }],
				timestamp: 1,
			});
			const firstKeptEntryId = sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "message retained after compaction" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});
			sessionManager.appendCompaction(hostileSummary, firstKeptEntryId, 1234);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			const persistedEntry = sessionManager.getEntries().find((entry) => entry.type === "compaction");
			if (persistedEntry?.type !== "compaction") {
				throw new Error("Expected a persisted compaction entry");
			}
			expect(Buffer.from(persistedEntry.summary)).toEqual(Buffer.from(hostileSummary));
			const onDiskEntry = readFileSync(sessionFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string; summary?: string })
				.find((entry) => entry.type === "compaction");
			expect(Buffer.from(onDiskEntry?.summary ?? "")).toEqual(Buffer.from(hostileSummary));

			expect(sessionManager.buildSessionContext().messages[0]).toMatchObject({
				role: "compactionSummary",
				summary: hostileSummary,
			});
			const rebuiltOutput = renderExpandedPersistedCompactionSummary(sessionManager);
			expect(rebuiltOutput).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007f-\u009f]/);
			expect(rebuiltOutput).not.toContain("attacker.invalid");
			expect(rebuiltOutput).not.toContain("stolen title");

			const reloaded = SessionManager.open(sessionFile);
			const reloadedSummary = reloaded.buildSessionContext().messages[0];
			expect(reloadedSummary).toMatchObject({ role: "compactionSummary", summary: hostileSummary });
			const reloadedOutput = renderExpandedPersistedCompactionSummary(reloaded);
			expect(reloadedOutput).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007f-\u009f]/);
			expect(reloadedOutput).not.toContain("attacker.invalid");
			expect(reloadedOutput).not.toContain("stolen title");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
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
			compactionQueuedMessages: [] as Array<{ text: string; mode: "steer" | "followUp" }>,
			getSessionLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false, getDoubleEscapeAction: () => "none" },
			turnWorkingTip: { resetForNewTurn: vi.fn(), resolve: vi.fn() },
			hideShortcutOverlay: vi.fn(),
			lastEditorText: "",
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
