import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import hooksExtension from "../../src/core/extensions/builtin/hooks/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import type { LoadedHookSources } from "../../src/core/extensions/types.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

export type Notification = {
	readonly message: string;
	readonly type: "info" | "warning" | "error" | undefined;
};

type HooksState = {
	readonly hooks: Record<string, HookStateEntry>;
};

type HookStateEntry = {
	readonly enabled: boolean;
	readonly trustedHash?: string;
};

const harnesses: Harness[] = [];

export function cleanupHooksCommandHarnesses(): void {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
}

export async function createHooksCommandHarness(options: { readonly projectHooks: unknown }) {
	const notifications: Notification[] = [];
	const payloads: unknown[] = [];
	const extensionsResult = await createTestExtensionsResult([{ factory: hooksExtension, path: "<builtin:hooks>" }]);
	const baseResourceLoader = createTestResourceLoader({ extensionsResult });
	let reloadCalls = 0;
	let hookSources: LoadedHookSources | undefined;
	const resourceLoader: ResourceLoader = {
		...baseResourceLoader,
		getLoadedHookSources: () => {
			if (hookSources === undefined) {
				throw new Error("hook sources not initialized");
			}
			return hookSources;
		},
		reload: async () => {
			reloadCalls += 1;
		},
	};
	const harness = await createHarness({
		resourceLoader,
		withConfiguredAuth: false,
		onPayload: (payload) => payloads.push(payload),
	});
	harnesses.push(harness);
	const agentDir = join(harness.tempDir, "agent");
	const projectHooksPath = join(harness.tempDir, ".senpi", "hooks.json");
	const projectStatePath = join(harness.tempDir, ".senpi", "hooks-state.json");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(harness.tempDir, ".senpi"), { recursive: true });
	writeFileSync(projectHooksPath, JSON.stringify(options.projectHooks), "utf-8");
	hookSources = {
		agentDir,
		cwd: harness.tempDir,
		globalHookSourcePaths: [],
		globalHooksPath: join(agentDir, "hooks.json"),
		preSessionHookSourcePaths: [],
		projectHookSourcePaths: [],
		projectHooksPath,
		runtimeHookSourcePaths: [],
	};
	await harness.session.bindExtensions({
		uiContext: createUiContext((message, type) => notifications.push({ message, type })),
		commandContextActions: {
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			editAssistantMessage: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {
				await resourceLoader.reload();
			},
		},
	});
	return {
		harness,
		notifications,
		payloads,
		projectHooksPath,
		projectStatePath,
		get reloadCalls() {
			return reloadCalls;
		},
	};
}

function createUiContext(
	onNotify: (message: string, type: "info" | "warning" | "error" | undefined) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: onNotify,
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
		custom: async <T>(): Promise<T> => {
			throw new Error("custom UI is not implemented in /hooks command tests");
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "themes are not used by /hooks tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

export function lastNotification(notifications: readonly Notification[]): Notification {
	const notification = notifications.at(-1);
	if (notification === undefined) {
		throw new Error("expected notification");
	}
	return notification;
}

export function firstHookId(message: string): string {
	const match = /^- (hk_[^ ]+)/m.exec(message);
	if (match === null) {
		throw new Error(`expected hook ID in message:\n${message}`);
	}
	return match[1];
}

export function readState(path: string): HooksState {
	const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf-8"));
	if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
		throw new Error("invalid hooks state");
	}
	const hooks: Record<string, HookStateEntry> = {};
	for (const [id, hook] of Object.entries(parsed.hooks)) {
		if (!isHookStateEntry(hook)) {
			throw new Error("invalid hooks state");
		}
		hooks[id] = hook;
	}
	return { hooks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isHookStateEntry(value: unknown): value is HookStateEntry {
	if (!isRecord(value) || typeof value.enabled !== "boolean") {
		return false;
	}
	return value.trustedHash === undefined || typeof value.trustedHash === "string";
}
