import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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
});
