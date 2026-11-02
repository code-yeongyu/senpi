import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

/** Container stand-in that keeps the components it was handed, in order. */
export type RecordingContainer = {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
};

export function createRecordingContainer(): RecordingContainer {
	const children: unknown[] = [];
	return {
		children,
		clear: () => {
			children.length = 0;
		},
		addChild: (child: unknown) => {
			children.push(child);
		},
	};
}

/** Plain-text render of everything the container currently holds. */
export function renderedText(container: RecordingContainer): string {
	return container.children
		.flatMap((child) => (child as { render: (width: number) => string[] }).render(80))
		.map(stripAnsi)
		.join("\n");
}

/** The component the rename editor swapped into the composer slot. */
export function activeInput(host: RenameEditorHost): { handleInput: (data: string) => void } {
	return host.editorContainer.children.at(-1) as { handleInput: (data: string) => void };
}

export type FakeUi = {
	focused: unknown;
	requestRender: () => void;
	setFocus: (component: unknown) => void;
};

function createFakeUi(): FakeUi {
	const ui: FakeUi = {
		focused: undefined,
		requestRender: () => {},
		setFocus: (component: unknown) => {
			ui.focused = component;
		},
	};
	return ui;
}

/** In-memory stand-in for the session's display-name surface. */
export type RenameSessionFake = {
	isCompacting: boolean;
	isStreaming: boolean;
	isBashRunning: boolean;
	messages: unknown[];
	renameCalls: string[];
	promptCalls: string[];
	readonly sessionName: string | undefined;
	prompt: (text: string, options?: unknown) => Promise<void>;
	setSessionName: (name: string) => void;
};

export function createRenameSession(initialName?: string): RenameSessionFake {
	const renameCalls: string[] = [];
	const promptCalls: string[] = [];
	let name = initialName;
	return {
		isCompacting: false,
		isStreaming: false,
		isBashRunning: false,
		messages: [],
		renameCalls,
		promptCalls,
		get sessionName() {
			return name;
		},
		prompt: async (text: string) => {
			promptCalls.push(text);
		},
		// Mirrors SessionManager.appendSessionInfo: newline runs collapse to spaces.
		setSessionName: (next: string) => {
			renameCalls.push(next);
			name = next.replace(/[\r\n]+/g, " ").trim() || undefined;
		},
	};
}

export type RenameCommandHost = ApplySessionName & {
	session: RenameSessionFake;
	sessionManager: { getSessionName: () => string | undefined };
	chatContainer: RecordingContainer;
	ui: FakeUi;
	warnings: string[];
	showWarning: (message: string) => void;
	showSessionRenameInput: () => void;
};

export type RenameEditorHost = RenameCommandHost & {
	editor: { setText: (text: string) => void };
	editorContainer: RecordingContainer;
	extensionInput: unknown;
	commitSessionRename: (value: string) => Promise<void>;
	hideExtensionInput: () => void;
};

type ApplySessionName = { applySessionName: (name: string) => Promise<void> };

export type RenameSubmitContext = RenameCommandHost & {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: { setText: (text: string) => void; addToHistory: (text: string) => void };
	editorTexts: string[];
	renameEditorOpens: number;
	handleRenameCommand: (text: string) => Promise<void>;
	flushPendingBashComponents: () => void;
	hideShortcutOverlay: () => void;
	isExtensionCommand: (text: string) => boolean;
	lastEditorText: string;
	pendingUserInputs: unknown[];
	pendingImages: Map<number, unknown>;
	optimisticUserEchoes: { begin: (text: string) => string; promptOptions: () => unknown; reject: () => void };
	takeSubmissionImages: (text: string) => unknown[];
	beginUserEcho: (text: string, images?: readonly unknown[]) => string | undefined;
};

export type RenameKeyHandlersContext = {
	defaultEditor: {
		onAction: (action: string, handler: () => void | Promise<void>) => void;
		onCtrlD?: () => void;
		onEscape?: () => void;
		onChange?: (text: string) => void;
		onPasteImage?: () => void;
	};
	ui: { onDebug?: () => void };
	actions: Map<string, () => void | Promise<void>>;
	renameEditorOpens: number;
	subscribeImageMarkers: (editor: unknown) => void;
	showSessionRenameInput: () => void;
};

type InteractiveModeInternals = {
	setupEditorSubmitHandler(this: RenameSubmitContext): void;
	setupKeyHandlers(this: RenameKeyHandlersContext): void;
	handleRenameCommand(this: RenameCommandHost, text: string): Promise<void>;
	commitSessionRename(this: RenameCommandHost, value: string): Promise<void>;
	applySessionName(this: RenameCommandHost, name: string): Promise<void>;
	showSessionRenameInput(this: RenameEditorHost): void;
	hideExtensionInput(this: RenameEditorHost): void;
	takeSubmissionImages(this: RenameSubmitContext, submittedText: string): unknown[];
	beginUserEcho(this: RenameSubmitContext, text: string, images?: readonly unknown[]): string | undefined;
};

/** Borrowed-receiver access to the private InteractiveMode methods under test. */
export const interactiveModeInternals = InteractiveMode.prototype as unknown as InteractiveModeInternals;

function createCommandHost(initialName?: string): RenameCommandHost {
	const session = createRenameSession(initialName);
	const warnings: string[] = [];
	return {
		session,
		sessionManager: { getSessionName: () => session.sessionName },
		chatContainer: createRecordingContainer(),
		ui: createFakeUi(),
		warnings,
		showWarning: (message: string) => {
			warnings.push(message);
		},
		showSessionRenameInput: () => {},
		applySessionName: async () => {},
	};
}

export function createRenameEditorHost(initialName?: string): RenameEditorHost {
	const host: RenameEditorHost = {
		...createCommandHost(initialName),
		editor: { setText: () => {} },
		editorContainer: createRecordingContainer(),
		extensionInput: undefined,
		commitSessionRename: async () => {},
		hideExtensionInput: () => {},
	};
	host.applySessionName = interactiveModeInternals.applySessionName.bind(host);
	host.showSessionRenameInput = interactiveModeInternals.showSessionRenameInput.bind(host);
	host.commitSessionRename = interactiveModeInternals.commitSessionRename.bind(host);
	host.hideExtensionInput = interactiveModeInternals.hideExtensionInput.bind(host);
	host.editorContainer.addChild(host.editor);
	return host;
}

export function createRenameSubmitContext(initialName?: string): RenameSubmitContext {
	const editorTexts: string[] = [];
	const context: RenameSubmitContext = {
		...createCommandHost(initialName),
		defaultEditor: {},
		editor: {
			setText: (text: string) => {
				editorTexts.push(text);
			},
			addToHistory: () => {},
		},
		editorTexts,
		renameEditorOpens: 0,
		handleRenameCommand: async () => {},
		flushPendingBashComponents: () => {},
		hideShortcutOverlay: () => {},
		isExtensionCommand: () => false,
		lastEditorText: "",
		pendingUserInputs: [],
		pendingImages: new Map(),
		optimisticUserEchoes: {
			begin: () => "pending-test",
			promptOptions: () => ({ preflightResult: () => {}, promptDisposition: () => {} }),
			reject: () => {},
		},
		takeSubmissionImages: () => [],
		beginUserEcho: () => undefined,
	};
	context.showSessionRenameInput = () => {
		context.renameEditorOpens += 1;
	};
	context.applySessionName = interactiveModeInternals.applySessionName.bind(context);
	context.handleRenameCommand = interactiveModeInternals.handleRenameCommand.bind(context);
	context.takeSubmissionImages = interactiveModeInternals.takeSubmissionImages.bind(context);
	context.beginUserEcho = interactiveModeInternals.beginUserEcho.bind(context);
	return context;
}

export function createKeyHandlersContext(): RenameKeyHandlersContext {
	const actions = new Map<string, () => void | Promise<void>>();
	const context: RenameKeyHandlersContext = {
		defaultEditor: {
			onAction: (action: string, handler: () => void | Promise<void>) => {
				actions.set(action, handler);
			},
		},
		ui: {},
		actions,
		renameEditorOpens: 0,
		subscribeImageMarkers: () => {},
		showSessionRenameInput: () => {
			context.renameEditorOpens += 1;
		},
	};
	return context;
}
