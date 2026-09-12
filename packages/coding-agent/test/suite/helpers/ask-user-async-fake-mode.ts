/**
 * Minimal `InteractiveMode` stand-in for the async ask-user tests: real
 * prototype methods run against a hand-built field set (editor container,
 * widget map, session spies) so the widget/overlay/submit path is exercised
 * without a terminal.
 */

import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { type Mock, vi } from "vitest";
import type { ExtensionUIContext, ExtensionWidgetOptions } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { type Theme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

type WidgetComponent = { render(width: number): string[]; dispose?(): void };
type WidgetContent = string[] | ((tui: TUI | undefined, thm: Theme) => WidgetComponent) | undefined;

export type FakeEditor = Text & { setText: Mock<(text: string) => void>; addToHistory: Mock<(text: string) => void> };

export type FakeSession = {
	isStreaming: boolean;
	isCompacting: boolean;
	messages: unknown[];
	sendUserMessage: Mock<(text: string, options?: { deliverAs?: "steer" | "followUp" }) => Promise<void>>;
	prompt: Mock<(text: string, options?: object) => Promise<void>>;
};

export type FakeInteractiveMode = {
	editorContainer: Container;
	editor: FakeEditor;
	defaultEditor: FakeEditor & { onSubmit?: (text: string) => Promise<void> | void };
	ui: { setFocus: Mock<(component: unknown) => void>; requestRender: Mock<() => void> };
	/** Read through the prototype's `session` getter from `runtimeHost.session`. */
	readonly session: FakeSession;
	runtimeHost: { session: FakeSession; sendHostUiProgress?: Mock<(record: unknown) => void> };
	onInputCallback: Mock<(input: unknown) => void>;
	handleDebugCommand: Mock<() => void>;
	showStatus: Mock<(message: string) => void>;
	createExtensionUIContext(): ExtensionUIContext;
	handleAskUserShortcut(data: string): boolean;
	setupEditorSubmitHandler(): void;
	/** Rendered text of the widget stored under `key`, or undefined when cleared. */
	widgetText(key: string): string | undefined;
	pressEditorKey(data: string): boolean;
	submitEditorText(text: string): Promise<void>;
};

export function createFakeInteractiveMode(options: { isStreaming?: boolean } = {}): FakeInteractiveMode {
	const widgets = new Map<string, WidgetComponent>();
	const editorContainer = new Container();
	const editor: FakeEditor = Object.assign(new Text("", 0, 0), { setText: vi.fn(), addToHistory: vi.fn() });
	editorContainer.addChild(editor);
	const session: FakeSession = {
		isStreaming: options.isStreaming ?? false,
		isCompacting: false,
		messages: [],
		sendUserMessage: vi.fn(async () => {}),
		prompt: vi.fn(async () => {}),
	};
	const fields = {
		editorContainer,
		editor,
		defaultEditor: editor,
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		runtimeHost: { session },
		onInputCallback: vi.fn(),
		handleDebugCommand: vi.fn(),
		showStatus: vi.fn(),
		askUserQuestion: undefined,
		asyncQuestion: undefined,
		lastEditorText: "",
		preResolvedSubmissionImages: undefined,
		pendingUserInputs: [],
		workingMessage: undefined,
		optimisticUserEchoes: { begin: () => "echo", promptOptions: () => ({}), reject: vi.fn() },
		hideShortcutOverlay: vi.fn(),
		updateWorkingIndicatorMessage: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		disposeActiveSelector: vi.fn(),
		isExtensionCommand: () => false,
		takeSubmissionImages: () => [],
		showError: (message: string) => {
			throw new Error(message);
		},
		setExtensionWidget: (key: string, content: WidgetContent, _options?: ExtensionWidgetOptions) => {
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
			if (content === undefined) return;
			if (Array.isArray(content)) {
				const container = new Container();
				for (const line of content) container.addChild(new Text(line, 0, 0));
				widgets.set(key, container);
				return;
			}
			widgets.set(key, content(undefined, theme));
		},
		widgetText: (key: string) => {
			const widget = widgets.get(key);
			return widget ? stripAnsi(widget.render(120).join("\n")) : undefined;
		},
		pressEditorKey: (data: string): boolean => fake.handleAskUserShortcut(data),
		submitEditorText: async (text: string) => {
			if (!fake.defaultEditor.onSubmit) fake.setupEditorSubmitHandler();
			await fake.defaultEditor.onSubmit?.(text);
		},
	};
	const fake: FakeInteractiveMode = Object.assign(Object.create(InteractiveMode.prototype), fields);
	return fake;
}
