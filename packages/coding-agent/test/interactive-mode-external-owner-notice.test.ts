import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

const EXTERNAL_OWNER_MESSAGE = "Compaction rejected: the Claude Agent SDK owns compaction for this session";

function makeFakeThis() {
	const chatContainer = new Container();
	return {
		isInitialized: true,
		externalOwnerCompactionNoticeShown: false,
		footer: { invalidate: vi.fn(), setCompactionDelegated: vi.fn() },
		autoCompactionEscapeHandler: undefined as (() => void) | undefined,
		autoCompactionLoader: undefined as { stop(): void } | undefined,
		autoCompactionProgressText: "",
		defaultEditor: {} as { onEscape?: () => void },
		session: { abortCompaction: vi.fn() },
		statusContainer: { clear: vi.fn() },
		chatContainer,
		sessionManager: {
			buildContextEntries: vi.fn().mockReturnValue([
				{
					type: "compaction",
					id: "latest",
					parentId: null,
					timestamp: "2025-01-01T00:00:00Z",
					summary: "summary",
					firstKeptEntryId: "kept",
					tokensBefore: 1,
				},
			]),
			reloadFromDisk: vi.fn(),
			countCompactions: vi.fn().mockReturnValue(0),
		},
		renderProjectTrustWarningIfNeeded: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		renderSessionEntries: vi.fn(),
		addMessageToChat: vi.fn(),
		addCompactionCostNotice: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		clearStatusIndicator: vi.fn(),
		compactionQueuedMessages: [] as Array<{ text: string; mode: "steer" | "followUp" }>,
		getSessionLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
		flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
		restoreQueuedMessagesToEditor: vi.fn().mockReturnValue(0),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
	};
}

type FakeThis = ReturnType<typeof makeFakeThis>;

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: FakeThis,
	event: Record<string, unknown>,
) => Promise<void>;

// Real production shape: core `_rejectCompaction(..., true, reason)` emits the
// external-owner rejection with `aborted: true` (agent-session.ts _rejectCompaction).
function externalOwnerEvent(reason = "pre_prompt") {
	return {
		type: "compaction_end",
		reason,
		aborted: true,
		accepted: false,
		rejectionCause: "external-owner",
		errorMessage: EXTERNAL_OWNER_MESSAGE,
		willRetry: false,
	};
}

function renderChat(fakeThis: FakeThis): string {
	return fakeThis.chatContainer.render(120).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("external-owner compaction rejection rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("two real-shape (aborted) auto external-owner rejections render exactly one muted notice and no error line", async () => {
		const fakeThis = makeFakeThis();

		await handleEvent.call(fakeThis, externalOwnerEvent());
		await handleEvent.call(fakeThis, externalOwnerEvent());

		const raw = renderChat(fakeThis);
		const plain = stripAnsi(raw);
		expect(plain).not.toContain(EXTERNAL_OWNER_MESSAGE);
		expect(countOccurrences(plain, "Claude Agent SDK")).toBe(1);
		// Muted informational styling, not error styling.
		const noticeLine = plain
			.split("\n")
			.find((line) => line.includes("Claude Agent SDK"))
			?.trim();
		expect(noticeLine).toBeTruthy();
		expect(raw).toContain(theme.fg("muted", noticeLine as string));
		expect(raw).not.toContain(theme.fg("error", noticeLine as string));
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenCalledWith(true);
	});

	test("manual external-owner rejection keeps explicit error feedback", async () => {
		const fakeThis = makeFakeThis();

		await handleEvent.call(fakeThis, externalOwnerEvent("manual"));

		expect(fakeThis.showError).toHaveBeenCalledWith(EXTERNAL_OWNER_MESSAGE);
		expect(stripAnsi(renderChat(fakeThis))).not.toContain("Claude Agent SDK");
	});

	test("a successful compaction re-arms the one-time notice", async () => {
		const fakeThis = makeFakeThis();

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(1);

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "threshold",
			accepted: true,
			result: { summary: "compacted", tokensBefore: 100 },
			willRetry: false,
		});
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(false);

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(1);
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(true);
	});

	test("a model switch re-arms the one-time notice", async () => {
		const fakeThis = Object.assign(makeFakeThis(), {
			session: {
				abortCompaction: vi.fn(),
				setModel: vi.fn().mockResolvedValue(undefined),
			},
			updateEditorBorderColor: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
			checkDaxnutsEasterEgg: vi.fn(),
		});
		const selectModelFromUi = Reflect.get(InteractiveMode.prototype, "selectModelFromUi") as (
			this: typeof fakeThis,
			model: { id: string },
		) => Promise<void>;

		await handleEvent.call(fakeThis, externalOwnerEvent());
		await selectModelFromUi.call(fakeThis, { id: "some-model" });
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(false);

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(2);
	});

	test("cycleModel re-arms the one-time notice and clears the footer marker", async () => {
		const fakeThis = Object.assign(makeFakeThis(), {
			session: {
				abortCompaction: vi.fn(),
				cycleModel: vi.fn().mockResolvedValue({
					model: { id: "next-model", name: "Next Model", reasoning: false },
					thinkingLevel: "off",
				}),
				favoriteModels: [],
			},
			updateEditorBorderColor: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
		});
		const cycleModel = Reflect.get(InteractiveMode.prototype, "cycleModel") as (
			this: typeof fakeThis,
			direction: "forward" | "backward",
		) => Promise<void>;

		await handleEvent.call(fakeThis, externalOwnerEvent());
		await cycleModel.call(fakeThis, "forward");
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(false);

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(2);
	});

	test("retry_fallback_applied re-arms the one-time notice and clears the footer marker", async () => {
		const fakeThis = Object.assign(makeFakeThis(), {
			showNoticeBox: vi.fn(),
			setExtensionStatus: vi.fn(),
		});

		await handleEvent.call(fakeThis, externalOwnerEvent());
		await handleEvent.call(fakeThis, {
			type: "retry_fallback_applied",
			from: "model-a",
			to: "model-b",
			reason: "provider-error",
		});
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(false);

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(2);
	});

	test("settings-only transcript rebuilds preserve the active delegation episode", async () => {
		// Post-#1188 core never re-emits the rejection while delegated, so a cosmetic
		// rebuild (hide-thinking, cache-notice, output padding) must not lose the
		// guard or the footer marker.
		const fakeThis = makeFakeThis();
		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: FakeThis,
		) => void;

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(fakeThis.externalOwnerCompactionNoticeShown).toBe(true);
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(true);

		rebuildChatFromMessages.call(fakeThis);

		// Episode state survives the rebuild; the rendered notice was cleared with
		// the chat, but the marker stays authoritative and the guard still suppresses
		// any (hypothetical) repeat notice.
		expect(fakeThis.externalOwnerCompactionNoticeShown).toBe(true);
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(true);
		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(0);
	});

	test("tree navigation rerenders reset the delegation episode", async () => {
		const fakeThis = makeFakeThis();
		const renderInitialMessages = Reflect.get(InteractiveMode.prototype, "renderInitialMessages") as (
			this: FakeThis,
		) => void;

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(1);

		// Branch/tree navigation clears the chat and rerenders via renderInitialMessages.
		fakeThis.chatContainer.clear();
		renderInitialMessages.call(fakeThis);
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(false);
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(0);

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(countOccurrences(stripAnsi(renderChat(fakeThis)), "Claude Agent SDK")).toBe(1);
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(true);
	});

	test("a model_changed event resets the delegation episode", async () => {
		const fakeThis = makeFakeThis();

		await handleEvent.call(fakeThis, externalOwnerEvent());
		expect(fakeThis.externalOwnerCompactionNoticeShown).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "model_changed",
			model: { id: "other-model", provider: "other", reasoning: false },
			thinkingLevel: "off",
			source: "selector",
		});

		expect(fakeThis.externalOwnerCompactionNoticeShown).toBe(false);
		expect(fakeThis.footer.setCompactionDelegated).toHaveBeenLastCalledWith(false);
	});

	test("rebindCurrentSession tolerates harness contexts without a footer", async () => {
		// Mirrors the minimal RebindContext used by
		// test/suite/regressions/5943-session-start-notify.test.ts: no footer, no
		// chrome. The delegation reset must not dereference the absent receiver.
		const context = {
			applyRuntimeSettings: vi.fn(),
			renderCurrentSessionState: vi.fn(),
			bindCurrentSessionExtensions: vi.fn().mockResolvedValue(undefined),
			subscribeToAgent: vi.fn(),
			updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
		};
		const rebindCurrentSession = Reflect.get(InteractiveMode.prototype, "rebindCurrentSession") as (
			this: typeof context,
			options?: { renderBeforeBind?: boolean },
		) => Promise<void>;

		await expect(rebindCurrentSession.call(context)).resolves.toBeUndefined();
		expect(context.bindCurrentSessionExtensions).toHaveBeenCalled();
	});
});
