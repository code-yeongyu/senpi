import { join } from "node:path";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionCommandContext, ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { theme } from "../../../src/modes/interactive/theme/theme.ts";
import type { TestRoot } from "./service-lifecycle.ts";

export interface UiCall {
	message: string;
	type: "info" | "warning" | "error";
}

interface SelectCall {
	title: string;
	options: string[];
}

export interface TestUi extends ExtensionUIContext {
	notifications: UiCall[];
	selectCalls: SelectCall[];
	confirmCalls: Array<{ title: string; message: string }>;
	customCalls: number;
}

export function createUi(options: { confirmResults?: boolean[]; selectResult?: string | undefined } = {}): TestUi {
	const notifications: UiCall[] = [];
	const selectCalls: SelectCall[] = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const confirmResults = [...(options.confirmResults ?? [])];
	return {
		notifications,
		selectCalls,
		confirmCalls,
		customCalls: 0,
		async select(title, selectOptions) {
			selectCalls.push({ title, options: [...selectOptions] });
			return options.selectResult;
		},
		async confirm(title, message) {
			confirmCalls.push({ title, message });
			return confirmResults.shift() ?? false;
		},
		async custom<T>(): Promise<T> {
			this.customCalls += 1;
			throw new Error("custom UI is not used by /mcp command tests");
		},
		notify(message, type = "info") {
			notifications.push({ message, type });
		},
		input: async () => undefined,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

export function createCtx(root: TestRoot, ui: TestUi): ExtensionCommandContext {
	const runner = new ExtensionRunner(
		[],
		createExtensionRuntime(),
		root.cwd,
		SessionManager.inMemory(),
		ModelRegistry.create(AuthStorage.create(join(root.agentDir, "auth.json"))),
	);
	runner.setUIContext(ui, "tui");
	return runner.createCommandContext();
}

export function normalize(value: string | undefined, root: TestRoot): string {
	if (value === undefined) return "";
	return value
		.split(root.agentDir)
		.join("<agentDir>")
		.split(root.cwd)
		.join("<cwd>")
		.replace(/uptime=\d+(?:\.\d+)?s/g, "uptime=<1s");
}

export function lastNotification(ui: TestUi): UiCall | undefined {
	return ui.notifications[ui.notifications.length - 1];
}

export function notification(ui: TestUi, fragment: string): UiCall | undefined {
	return ui.notifications.find((item) => item.message.includes(fragment));
}
